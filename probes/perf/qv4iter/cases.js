.pragma library
// Map and Set iteration while the loop body deletes or adds entries: for...of (the iterator
// protocol) against forEach, in whatever engine loads this file. probes/perf/qv4iter/run.py
// runs it in QV4 (the qml tool, the same libQt6Qml as KWin) and in Node (V8, the reference
// for the ECMAScript semantics). The result is the visit order as a string of keys.

function visit(kind, mutate) {
  var m = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]);
  var s = new Set(["a", "b", "c", "d", "e"]);
  var seen = [];
  // The mutation gets the collection being walked and the key just visited.
  var onMap = function (k) { seen.push(k); mutate(m, k, seen); };
  var onSet = function (k) { seen.push(k); mutate(s, k, seen); };
  if (kind === "map-for-of") { for (var e of m) onMap(e[0]); }
  else if (kind === "map-keys-for-of") { for (var k of m.keys()) onMap(k); }
  else if (kind === "map-forEach") m.forEach(function (v, k) { onMap(k); });
  else if (kind === "set-for-of") { for (var x of s) onSet(x); }
  else if (kind === "set-forEach") s.forEach(function (x) { onSet(x); });
  return seen.join("");
}

function del(c, k) { c.delete(k); }
function put(c, k) { if (c instanceof Map) c.set(k, 0); else c.add(k); }

var CASES = {
  "delete-current": function (c, k) { if (k === "b") del(c, "b"); },
  "delete-next": function (c, k) { if (k === "b") del(c, "c"); },
  "delete-earlier": function (c, k) { if (k === "c") del(c, "a"); },
  "delete-current-and-next": function (c, k) { if (k === "b") { del(c, "b"); del(c, "c"); } },
  "set-existing": function (c, k) { if (c instanceof Map) c.set(k, 9); },
  "add-new": function (c, k) { if (k === "b") put(c, "z"); },
  "delete-and-readd-current-once": function (c, k, seen) { if (k === "b" && seen.indexOf("b") === seen.length - 1) { del(c, "b"); put(c, "b"); } },
  "clear": function (c, k) { if (k === "b") c.clear(); },
};
var KINDS = ["map-for-of", "map-keys-for-of", "map-forEach", "set-for-of", "set-forEach"];

function results() {
  var out = {};
  for (var name in CASES) {
    out[name] = {};
    for (var i = 0; i < KINDS.length; ++i) out[name][KINDS[i]] = visit(KINDS[i], CASES[name]);
  }
  return out;
}
