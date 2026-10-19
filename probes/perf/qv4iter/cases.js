.pragma library
// Map and Set iteration while the loop body deletes or adds entries: for...of (the iterator
// protocol) against forEach, in whatever engine loads this file. probes/perf/qv4iter/run.py
// runs it in QV4 (the qml tool, the same libQt6Qml as KWin) and in Node (V8, the reference
// for the ECMAScript semantics). The result is the visit order as a string of keys.
// Arrays are included because tools/itercheck.ts allows for...of over them: their iteration
// under mutation must match ECMAScript in QV4 too.

function visit(kind, mutate) {
  // Map values carry their key, so a values() walk reports keys too.
  var m = new Map([["a", { k: "a" }], ["b", { k: "b" }], ["c", { k: "c" }], ["d", { k: "d" }], ["e", { k: "e" }]]);
  var s = new Set(["a", "b", "c", "d", "e"]);
  var arr = ["a", "b", "c", "d", "e"];
  var seen = [];
  // The mutation gets the collection being walked and the key just visited.
  var onMap = function (k) { seen.push(k); mutate(m, k, seen); };
  var onSet = function (k) { seen.push(k); mutate(s, k, seen); };
  var onArr = function (k) { seen.push(k); mutate(arr, k, seen); };
  if (kind === "map-for-of") { for (var e of m) onMap(e[0]); }
  else if (kind === "map-keys-for-of") { for (var k of m.keys()) onMap(k); }
  else if (kind === "map-forEach") m.forEach(function (v, k) { onMap(k); });
  else if (kind === "set-for-of") { for (var x of s) onSet(x); }
  else if (kind === "set-forEach") s.forEach(function (x) { onSet(x); });
  else if (kind === "map-values-for-of") { for (var v of m.values()) onMap(v.k); }
  else if (kind === "map-entries-for-of") { for (var en of m.entries()) onMap(en[0]); }
  else if (kind === "set-values-for-of") { for (var y of s.values()) onSet(y); }
  else if (kind === "array-for-of") { for (var z of arr) onArr(z); }
  else if (kind === "array-forEach") arr.forEach(function (z) { onArr(z); });
  return seen.join("");
}

function del(c, k) {
  if (Array.isArray(c)) { var i = c.indexOf(k); if (i >= 0) c.splice(i, 1); }
  else c.delete(k);
}
function put(c, k) {
  if (Array.isArray(c)) c.push(k);
  else if (c instanceof Map) c.set(k, { k: k });
  else c.add(k);
}

var CASES = {
  "delete-current": function (c, k) { if (k === "b") del(c, "b"); },
  "delete-next": function (c, k) { if (k === "b") del(c, "c"); },
  "delete-earlier": function (c, k) { if (k === "c") del(c, "a"); },
  "delete-current-and-next": function (c, k) { if (k === "b") { del(c, "b"); del(c, "c"); } },
  "set-existing": function (c, k) { if (c instanceof Map) c.set(k, { k: k }); },
  "add-new": function (c, k) { if (k === "b") put(c, "z"); },
  "delete-and-readd-current-once": function (c, k, seen) { if (k === "b" && seen.indexOf("b") === seen.length - 1) { del(c, "b"); put(c, "b"); } },
  "clear": function (c, k) { if (k === "b") { if (Array.isArray(c)) c.length = 0; else c.clear(); } },
  // Insertion (QV4 semantics measured separately from deletion).
  "add-two": function (c, k) { if (k === "b") { put(c, "z"); put(c, "y"); } },
  "add-at-last": function (c, k) { if (k === "e") put(c, "z"); },
  // Delete-and-re-add of another entry: what engine.outputsRekeyed does to a context it renames.
  "rekey-earlier": function (c, k) { if (k === "c") { del(c, "a"); put(c, "z"); } },
  "rekey-current": function (c, k) { if (k === "b") { del(c, "b"); put(c, "z"); } },
  "rekey-current-and-later": function (c, k) { if (k === "b") { del(c, "b"); put(c, "z"); del(c, "d"); put(c, "y"); } },
  "delete-all-earlier": function (c, k) { if (k === "c") { del(c, "a"); del(c, "b"); } },
  "delete-last-at-last": function (c, k) { if (k === "e") del(c, "e"); },
};
var KINDS = ["map-for-of", "map-keys-for-of", "map-values-for-of", "map-entries-for-of", "map-forEach",
             "set-for-of", "set-values-for-of", "set-forEach", "array-for-of", "array-forEach"];

function results() {
  var out = {};
  for (var name in CASES) {
    out[name] = {};
    for (var i = 0; i < KINDS.length; ++i) out[name][KINDS[i]] = visit(KINDS[i], CASES[name]);
  }
  return out;
}
