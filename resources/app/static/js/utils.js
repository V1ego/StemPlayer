/* utils.js — tiny helpers for the Web Stem Player UI. */
(function (global) {
  "use strict";
  var U = {
    clamp: function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
    formatTime: function (s) {
      s = Math.max(0, s || 0);
      var m = Math.floor(s / 60);
      var ss = Math.floor(s % 60);
      return m + ":" + (ss < 10 ? "0" : "") + ss;
    },
    debounce: function (fn, ms) {
      var t;
      return function () {
        var a = arguments, c = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(c, a); }, ms);
      };
    },
    fetchJSON: function (url, opt) {
      return fetch(url, opt).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    },
    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
    on: function (el, ev, fn, opt) { el && el.addEventListener(ev, fn, opt); }
  };
  global.StemUtils = U;
})(window);
