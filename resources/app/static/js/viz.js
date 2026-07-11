/* viz.js — generative-art visualizer (p5 instance mode).
 *
 * The 4 stems are 4 coexisting force fields; the canvas shows their additive
 * interference, not a decoration.
 *   vocals (amber)   -> flow-field particle stream
 *   drums  (crimson) -> beat rings / radial pulses (onset-driven)
 *   bass   (magenta) -> perlin-deformed organic blob
 *   other  (cyan)    -> noise terrain lines
 * Trails come from a translucent background fade each frame.
 *
 * bundle-dynamic-imports: p5.js is loaded dynamically instead of via a
 * blocking <script> tag. createVisualizer returns a lazy proxy that queues
 * method calls until p5.js is ready, so the caller API is unchanged.
 */
(function (global) {
  "use strict";

  var COLORS = {
    vocals: "#D8C9A8",
    drums: "#C4423A",
    bass: "#A8C8D8",
    other: "#5A7A8A"
  };

  // Dynamically load p5.js only when the visualizer is created
  function loadP5() {
    return new Promise(function (resolve, reject) {
      if (global.p5) return resolve(global.p5);
      var s = document.createElement("script");
      s.src = "/static/js/vendor/p5.min.js";
      s.onload = function () { resolve(global.p5); };
      s.onerror = function () { reject(new Error("Failed to load p5.js")); };
      document.head.appendChild(s);
    });
  }

  function createVisualizer(mount) {
    // Lazy proxy: queues method calls until p5 sketch is ready
    var pendingEngine = null;
    var pendingFrameRate = null;
    var sketchInstance = null;

    var proxy = {
      setEngine: function (e) {
        if (sketchInstance) sketchInstance.setEngine(e);
        else pendingEngine = e;
      },
      frameRate: function (fps) {
        if (sketchInstance) sketchInstance.frameRate(fps);
        else pendingFrameRate = fps;
      }
    };

    var sketch = function (p) {
      var engine = null, W = 0, H = 0;
      var parts = [];
      var rings = [];
      var buf = {};
      var prevKick = 0;
      // js-cache-property-access: pre-create colors and cache RGB components
      // so we don't call p.color() + p.red()/green()/blue() every frame
      var rgb = {};  // stem -> {r, g, b}

      function ensure(stem) {
        if (!buf[stem]) buf[stem] = new Uint8Array(1024);
        return buf[stem];
      }
      function freq(stem) {
        var a = engine && engine.getAnalyser(stem);
        if (!a) return null;
        var b = ensure(stem);
        a.getByteFrequencyData(b);
        return b;
      }
      function energy(stem) {
        var b = freq(stem); if (!b) return 0;
        var s = 0; for (var i = 0; i < b.length; i++) s += b[i];
        return s / (b.length * 255);
      }
      function band(stem, from, to) {
        var b = freq(stem); if (!b) return 0;
        var s = 0, c = 0; for (var i = from; i < to && i < b.length; i++) { s += b[i]; c++; }
        return c ? s / (c * 255) : 0;
      }

      function newP() { return { x: Math.random() * W, y: Math.random() * H, life: 80 + Math.random() * 200 }; }

      p.setup = function () {
        var r = mount.getBoundingClientRect();
        W = Math.max(320, Math.floor(r.width || global.innerWidth));
        H = Math.max(240, Math.floor(r.height || global.innerHeight));
        var c = p.createCanvas(W, H);
        c.parent(mount);
        p.frameRate(60);
        p.colorMode(p.RGB, 255);
        // pre-create colors and cache RGB components once
        Object.keys(COLORS).forEach(function (stem) {
          var col = p.color(COLORS[stem]);
          rgb[stem] = { r: p.red(col), g: p.green(col), b: p.blue(col) };
        });
        for (var i = 0; i < 440; i++) parts.push(newP());
      };

      p.windowResized = function () {
        var r = mount.getBoundingClientRect();
        W = Math.max(320, Math.floor(r.width));
        H = Math.max(240, Math.floor(r.height));
        p.resizeCanvas(W, H);
      };

      p.setEngine = function (e) { engine = e; };

      p.draw = function () {
        p.clear();   // transparent clear — let body background show through
        var ev = energy("vocals"), ed = energy("drums"), eb = energy("bass"), eo = energy("other");
        drawBlob(eb);
        drawTerrain(eo);
        var kick = band("drums", 0, 6);
        if (kick - prevKick > 0.08 && kick > 0.22) rings.push({ r: Math.min(W, H) * 0.10, a: 0.9 });
        prevKick = kick;
        drawRings(ed);
        drawParticles(ev);
      };

      function drawBlob(e) {
        if (e <= 0.002) return;
        p.push(); p.translate(W / 2, H / 2);
        var baseR = Math.min(W, H) * 0.15 * (0.6 + e * 1.7);
        var c = rgb.bass;
        for (var layer = 0; layer < 3; layer++) {
          p.noFill();
          p.stroke(c.r, c.g, c.b, 60 + layer * 34);
          p.strokeWeight(2);
          p.beginShape();
          var pts = 96;
          for (var i = 0; i <= pts; i++) {
            var a = (i / pts) * p.TWO_PI;
            var n = p.noise(Math.cos(a) * 1.6 + layer * 10, Math.sin(a) * 1.6 + layer * 10, p.frameCount * 0.004);
            var rr = baseR * (0.8 + n * 0.7) * (1 + layer * 0.15);
            p.vertex(Math.cos(a) * rr, Math.sin(a) * rr);
          }
          p.endShape(p.CLOSE);
        }
        p.pop();
      }

      function drawTerrain(e) {
        if (e <= 0.002) return;
        p.push();
        var c = rgb.other;
        var lines = Math.floor(3 + e * 7);
        for (var l = 0; l < lines; l++) {
          p.noFill();
          p.stroke(c.r, c.g, c.b, 36 + l * 18);
          p.strokeWeight(1);
          p.beginShape();
          var yBase = H * 0.62 + l * 18;
          for (var x = 0; x <= W; x += 12) {
            var n = p.noise(x * 0.004, l * 3 + p.frameCount * 0.003);
            p.vertex(x, yBase + (n - 0.5) * 130 * (0.4 + e));
          }
          p.endShape();
        }
        p.pop();
      }

      function drawRings(e) {
        if (rings.length === 0 && e <= 0.002) return;
        p.push(); p.translate(W / 2, H / 2);
        var c = rgb.drums;
        for (var i = rings.length - 1; i >= 0; i--) {
          var r = rings[i];
          r.r += 2 + e * 7;
          r.a *= 0.955;
          p.noFill();
          p.stroke(c.r, c.g, c.b, 255 * r.a);
          p.strokeWeight(2);
          p.circle(0, 0, r.r * 2);
          if (r.a < 0.03 || r.r > Math.max(W, H)) rings.splice(i, 1);
        }
        p.pop();
      }

      function drawParticles(e) {
        var c = rgb.vocals;
        for (var i = 0; i < parts.length; i++) {
          var pt = parts[i];
          var nx = p.noise(pt.x * 0.0035, pt.y * 0.0035, p.frameCount * 0.002) * p.TWO_PI * 2;
          var sp = 0.6 + e * 5;
          pt.x += Math.cos(nx) * sp;
          pt.y += Math.sin(nx) * sp - e * 2.2;
          pt.life -= 1;
          if (pt.life <= 0 || pt.x < 0 || pt.x > W || pt.y < 0 || pt.y > H) {
            pt.x = Math.random() * W; pt.y = H + Math.random() * 40; pt.life = 120 + Math.random() * 180;
          }
          p.noStroke();
          p.fill(c.r, c.g, c.b, 110 + e * 120);
          p.circle(pt.x, pt.y, 1.6 + e * 2.6);
        }
      }
    };

    // Load p5.js dynamically, then create the sketch and flush pending calls
    loadP5().then(function (P5) {
      sketchInstance = new P5(sketch);
      if (pendingEngine !== null) sketchInstance.setEngine(pendingEngine);
      if (pendingFrameRate !== null) sketchInstance.frameRate(pendingFrameRate);
    }).catch(function (err) {
      console.warn("[viz] Failed to load p5.js, visualizer disabled:", err.message);
    });

    return proxy;
  }

  global.createVisualizer = createVisualizer;
})(window);
