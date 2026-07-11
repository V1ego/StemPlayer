"""NCM (NetEase Cloud Music) encrypted file decryption.

Algorithm based on the ncmdump library by Nzix.
"""
import base64
import binascii
import json
import struct
from pathlib import Path

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
from Crypto.Util.strxor import strxor as XOR

_CORE_KEY = binascii.a2b_hex("687A4852416D736F356B496E62617857")
_META_KEY = binascii.a2b_hex("2331346C6A6B5F215C5D2630553C2728")
_MAGIC = b"CTENFDAM"


def decrypt_ncm(ncm_path: Path, output_dir: Path | None = None) -> tuple[Path, dict]:
    """Decrypt a .ncm file -> (output_path, metadata_dict)."""
    ncm_path = Path(ncm_path)
    output_dir = output_dir or ncm_path.parent

    with open(ncm_path, "rb") as f:
        header = f.read(8)
        if header != _MAGIC:
            raise ValueError(f"不是有效的 NCM 文件（magic: {header!r}）")
        f.seek(2, 1)

        key_length = struct.unpack("<I", f.read(4))[0]
        key_data = bytearray(f.read(key_length))
        key_data = bytes(bytearray([b ^ 0x64 for b in key_data]))

        cryptor = AES.new(_CORE_KEY, AES.MODE_ECB)
        key_data = unpad(cryptor.decrypt(key_data), 16)[17:]
        key_length = len(key_data)

        key = bytearray(key_data)
        S = bytearray(range(256))
        j = 0
        for i in range(256):
            j = (j + S[i] + key[i % key_length]) & 0xFF
            S[i], S[j] = S[j], S[i]

        meta_length = struct.unpack("<I", f.read(4))[0]
        if meta_length:
            meta_data = bytearray(f.read(meta_length))
            meta_data = bytes(bytearray([b ^ 0x63 for b in meta_data]))
            identifier = meta_data.decode("utf-8")  # noqa: F841
            meta_data = base64.b64decode(meta_data[22:])

            cryptor = AES.new(_META_KEY, AES.MODE_ECB)
            meta_data = unpad(cryptor.decrypt(meta_data), 16).decode("utf-8")
            metadata = json.loads(meta_data[6:])
        else:
            metadata = {"format": "flac" if ncm_path.stat().st_size > 1024 ** 2 * 16 else "mp3"}

        f.seek(5, 1)

        image_space = struct.unpack("<I", f.read(4))[0]
        image_size = struct.unpack("<I", f.read(4))[0]
        if image_size:
            f.read(image_size)

        f.seek(image_space - image_size, 1)

        data = f.read()

        stream = [S[(S[i] + S[(i + S[i]) & 0xFF]) & 0xFF] for i in range(256)]
        stream = bytes(bytearray(stream * (len(data) // 256 + 1))[1:1 + len(data)])
        data = XOR(data, stream)

    fmt = metadata.get("format", "mp3")

    base = ncm_path.stem
    if metadata.get("musicName"):
        name = metadata["musicName"]
        for ext in (".mp3", ".flac", ".ncm"):
            if name.lower().endswith(ext):
                name = name[:-len(ext)]
        base = name
    base = "".join(c for c in base if c not in '\\/:*?"<>|')[:80] or "track"

    output_path = output_dir / f"{base}.{fmt}"
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(data)

    return output_path, metadata
