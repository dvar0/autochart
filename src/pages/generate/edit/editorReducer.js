// Reducer + history for the piano-roll editor. The editor doc (parsed by
// chartEditor.parseEditableChart) is the source of truth; every committed
// operation snapshots the previous doc for undo. Drag gestures are committed
// as a single action on pointerup, so history stays one-entry-per-gesture.

import { cloneEditorDoc, quantizeTick, snapTicks } from "./chartEditor.js";

const HISTORY_CAP = 100;

export function createEditorState(doc) {
  return {
    doc,
    selectedNoteIds: [],
    selectedRangeIds: [],
    past: [],
    future: [],
    revision: 0,
  };
}

function clampLane(lane) {
  return Math.max(0, Math.min(4, lane));
}

// Merges notes that share a tick into one chord note, enforcing open/fret
// exclusivity and lane de-duplication.
function mergeNotesAtSameTick(notes) {
  const byTick = new Map();
  for (const note of notes) {
    const existing = byTick.get(note.tick);
    if (!existing) {
      byTick.set(note.tick, { ...note, lanes: [...note.lanes], sustainsByLane: { ...note.sustainsByLane } });
      continue;
    }
    for (const lane of note.lanes) if (!existing.lanes.includes(lane)) existing.lanes.push(lane);
    existing.sustainsByLane = { ...existing.sustainsByLane, ...note.sustainsByLane };
    existing.open = existing.open || note.open;
    existing.tap = existing.tap || note.tap;
    existing.force = existing.force || note.force;
  }
  const out = [];
  for (const note of byTick.values()) {
    if (note.open && note.lanes.length) {
      note.open = false;
      delete note.sustainsByLane.open;
    }
    note.lanes = [...new Set(note.lanes)].sort((a, b) => a - b);
    // Drop stale per-lane sustains for lanes that no longer exist.
    const clean = {};
    if (note.open) clean.open = note.sustainsByLane.open || 0;
    for (const lane of note.lanes) clean[lane] = note.sustainsByLane[lane] || 0;
    note.sustainsByLane = clean;
    out.push(note);
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

function withNotes(doc, notes) {
  return { ...doc, notes: mergeNotesAtSameTick(notes) };
}

function paintGameplayFlag(note, flag, enabled) {
  if (flag === "tap") return { ...note, tap: enabled, force: enabled ? false : note.force };
  if (flag === "force") return { ...note, force: enabled, tap: enabled ? false : note.tap };
  return note;
}

function makeRangeId(kind) {
  return `${kind === "solo" ? "solo" : "sp"}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeRanges(ranges, preferredId = "") {
  const groups = new Map();
  for (const range of ranges) {
    const startTick = Math.max(0, Math.min(range.startTick, range.endTick));
    const endTick = Math.max(0, Math.max(range.startTick, range.endTick));
    if (endTick <= startTick) continue;
    const clean = { ...range, startTick, endTick };
    const group = groups.get(clean.kind) || [];
    group.push(clean);
    groups.set(clean.kind, group);
  }

  const merged = [];
  for (const [kind, group] of groups) {
    group.sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
    let current = null;
    for (const range of group) {
      if (!current || range.startTick > current.endTick) {
        if (current) merged.push(current);
        current = { ...range, kind };
        continue;
      }
      current.startTick = Math.min(current.startTick, range.startTick);
      current.endTick = Math.max(current.endTick, range.endTick);
      if (range.id === preferredId || (current.id !== preferredId && range.startTick < current.startTick)) {
        current.id = range.id;
      }
    }
    if (current) merged.push(current);
  }
  return merged.sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick || a.kind.localeCompare(b.kind));
}

function nextFreeTick(tick, usedTicks, step) {
  let next = Math.max(0, tick);
  while (usedTicks.has(next)) next += step;
  usedTicks.add(next);
  return next;
}

// Pushes the current doc onto the undo stack and applies a producer.
function commit(state, nextDoc) {
  const past = [...state.past, state.doc];
  if (past.length > HISTORY_CAP) past.shift();
  return { ...state, doc: nextDoc, past, future: [], revision: state.revision + 1 };
}

function applyOperation(state, action) {
  const doc = state.doc;
  switch (action.type) {
    case "moveNotes": {
      const ids = new Set(action.ids);
      const deltaTick = action.deltaTick || 0;
      const deltaLane = action.deltaLane || 0;
      if (!ids.size || (!deltaTick && !deltaLane)) return state;
      const moved = doc.notes.map((note) => {
        if (!ids.has(note.id)) return note;
        const tick = Math.max(0, note.tick + deltaTick);
        if (note.open || !deltaLane) return { ...note, tick };
        const lanes = [];
        const sustainsByLane = {};
        for (const lane of note.lanes) {
          const next = clampLane(lane + deltaLane);
          if (!lanes.includes(next)) {
            lanes.push(next);
            sustainsByLane[next] = note.sustainsByLane[lane] || 0;
          }
        }
        return { ...note, tick, lanes, sustainsByLane };
      });
      return commit(state, withNotes(doc, moved));
    }
    case "deleteNotes": {
      const ids = new Set(action.ids);
      if (!ids.size) return state;
      const notes = doc.notes.filter((note) => !ids.has(note.id));
      return { ...commit(state, withNotes(doc, notes)), selectedNoteIds: [] };
    }
    case "eraseGesture": {
      const ids = new Set(action.ids || []);
      const rangeIds = new Set(action.rangeIds || []);
      const sustainCuts = new Map((action.sustainCuts || []).map((cut) => [cut.id, Math.max(0, Math.round(cut.sustain || 0))]));
      const rangeCuts = new Map((action.rangeCuts || []).map((cut) => [cut.id, Math.max(0, Math.round(cut.endTick || 0))]));
      if (!ids.size && !rangeIds.size && !sustainCuts.size && !rangeCuts.size) return state;
      const notes = doc.notes
        .filter((note) => !ids.has(note.id))
        .map((note) => {
          if (!sustainCuts.has(note.id)) return note;
          const value = sustainCuts.get(note.id);
          const sustainsByLane = {};
          if (note.open) sustainsByLane.open = value;
          for (const lane of note.lanes) sustainsByLane[lane] = value;
          return { ...note, sustainsByLane };
        });
      const ranges = doc.ranges
        .filter((range) => !rangeIds.has(range.id))
        .map((range) => {
          if (!rangeCuts.has(range.id)) return range;
          const endTick = Math.max(range.startTick, Math.min(range.endTick, rangeCuts.get(range.id)));
          return { ...range, endTick };
        })
        .filter((range) => range.endTick > range.startTick);
      const nextDoc = withNotes({ ...doc, ranges }, notes);
      return {
        ...commit(state, nextDoc),
        selectedNoteIds: pruneNoteSelection(state.selectedNoteIds, nextDoc),
        selectedRangeIds: pruneRangeSelection(state.selectedRangeIds, nextDoc),
      };
    }
    case "addNote": {
      const tick = Math.max(0, action.tick);
      const lane = action.lane; // 0-4 or "open"
      const sustain = Math.max(0, action.sustain || 0);
      const existing = doc.notes.find((note) => note.tick === tick);
      let notes;
      if (existing) {
        const note = { ...existing, lanes: [...existing.lanes], sustainsByLane: { ...existing.sustainsByLane } };
        if (lane === "open") {
          note.open = true;
          note.lanes = [];
          note.sustainsByLane = { open: sustain };
        } else {
          note.open = false;
          if (!note.lanes.includes(lane)) note.lanes.push(lane);
          note.sustainsByLane[lane] = sustain;
        }
        notes = doc.notes.map((n) => (n.id === existing.id ? note : n));
      } else {
        const note = {
          id: `note_${tick}_${Math.random().toString(36).slice(2, 7)}`,
          tick,
          lanes: lane === "open" ? [] : [lane],
          open: lane === "open",
          tap: false,
          force: false,
          sustainsByLane: lane === "open" ? { open: sustain } : { [lane]: sustain },
        };
        notes = [...doc.notes, note];
      }
      return commit(state, withNotes(doc, notes));
    }
    case "toggleTap": {
      const ids = new Set(action.ids);
      if (!ids.size) return state;
      const notes = doc.notes.map((note) => (ids.has(note.id) ? paintGameplayFlag(note, "tap", !note.tap) : note));
      return commit(state, { ...doc, notes });
    }
    case "toggleForce": {
      const ids = new Set(action.ids);
      if (!ids.size) return state;
      const notes = doc.notes.map((note) => (ids.has(note.id) ? paintGameplayFlag(note, "force", !(note.force && !note.tap)) : note));
      return commit(state, { ...doc, notes });
    }
    case "paintNoteFlag": {
      const ids = new Set(action.ids);
      if (!ids.size) return state;
      const notes = doc.notes.map((note) => (ids.has(note.id) ? paintGameplayFlag(note, action.flag, Boolean(action.enabled)) : note));
      return commit(state, { ...doc, notes });
    }
    case "setSustain": {
      // Sets a shared sustain length across the note's lanes (clamped >= 0).
      const value = Math.max(0, Math.round(action.sustain || 0));
      const notes = doc.notes.map((note) => {
        if (note.id !== action.id) return note;
        const sustainsByLane = {};
        if (note.open) sustainsByLane.open = value;
        for (const lane of note.lanes) sustainsByLane[lane] = value;
        return { ...note, sustainsByLane };
      });
      return commit(state, { ...doc, notes });
    }
    case "quantizeSelection": {
      const ids = new Set(action.ids?.length ? action.ids : doc.notes.map((n) => n.id));
      const notes = doc.notes.map((note) =>
        ids.has(note.id) ? { ...note, tick: quantizeTick(note.tick, doc.resolution, action.snap) } : note
      );
      return commit(state, withNotes(doc, notes));
    }
    case "splitChords": {
      const ids = new Set(action.ids || []);
      if (!ids.size) return state;
      const step = snapTicks(doc.resolution, action.snap) || Math.max(1, Math.round(doc.resolution / 4));
      const usedTicks = new Set(doc.notes.filter((note) => !ids.has(note.id)).map((note) => note.tick));
      const notes = [];
      let changed = false;
      for (const note of doc.notes) {
        if (!ids.has(note.id) || note.open || note.lanes.length <= 1) {
          notes.push(note);
          continue;
        }
        changed = true;
        for (const [index, lane] of [...note.lanes].sort((a, b) => a - b).entries()) {
          const tick = nextFreeTick(note.tick + step * index, usedTicks, step);
          notes.push({
            ...note,
            id: `${note.id}_split_${lane}_${Math.random().toString(36).slice(2, 6)}`,
            tick,
            lanes: [lane],
            open: false,
            sustainsByLane: { [lane]: note.sustainsByLane[lane] || 0 },
          });
        }
      }
      if (!changed) return state;
      return { ...commit(state, withNotes(doc, notes)), selectedNoteIds: [] };
    }
    case "addRange": {
      const startTick = Math.max(0, Math.min(action.startTick, action.endTick));
      const endTick = Math.max(0, Math.max(action.startTick, action.endTick));
      if (endTick <= startTick) return state;
      const range = {
        id: makeRangeId(action.kind),
        kind: action.kind,
        startTick,
        endTick,
      };
      const ranges = normalizeRanges([...doc.ranges, range], range.id);
      return { ...commit(state, { ...doc, ranges }), selectedRangeIds: [range.id] };
    }
    case "updateRange": {
      const ranges = normalizeRanges(doc.ranges.map((range) => {
        if (range.id !== action.id) return range;
        const startTick = Math.max(0, action.startTick ?? range.startTick);
        const endTick = Math.max(0, action.endTick ?? range.endTick);
        return { ...range, startTick: Math.min(startTick, endTick), endTick: Math.max(startTick, endTick) };
      }), action.id);
      const nextDoc = { ...doc, ranges };
      return { ...commit(state, nextDoc), selectedRangeIds: pruneRangeSelection(state.selectedRangeIds, nextDoc) };
    }
    case "deleteRanges": {
      const ids = new Set(action.ids);
      if (!ids.size) return state;
      const ranges = doc.ranges.filter((range) => !ids.has(range.id));
      return { ...commit(state, { ...doc, ranges }), selectedRangeIds: [] };
    }
    default:
      return state;
  }
}

export function editorReducer(state, action) {
  switch (action.type) {
    case "replaceDoc":
      return createEditorState(action.doc);
    case "select": {
      const notes = action.additive
        ? toggleMembership(state.selectedNoteIds, action.noteIds || [])
        : action.noteIds || [];
      const ranges = action.additive
        ? toggleMembership(state.selectedRangeIds, action.rangeIds || [])
        : action.rangeIds || [];
      return { ...state, selectedNoteIds: notes, selectedRangeIds: ranges };
    }
    case "clearSelection":
      return { ...state, selectedNoteIds: [], selectedRangeIds: [] };
    case "deleteSelection": {
      let next = state;
      if (state.selectedRangeIds.length) {
        next = applyOperation(next, { type: "deleteRanges", ids: state.selectedRangeIds });
      }
      if (state.selectedNoteIds.length) {
        next = applyOperation(next, { type: "deleteNotes", ids: state.selectedNoteIds });
      }
      return next;
    }
    case "undo": {
      if (!state.past.length) return state;
      const past = [...state.past];
      const previous = past.pop();
      return {
        ...state,
        doc: previous,
        past,
        future: [state.doc, ...state.future].slice(0, HISTORY_CAP),
        revision: state.revision + 1,
        selectedNoteIds: pruneNoteSelection(state.selectedNoteIds, previous),
        selectedRangeIds: pruneRangeSelection(state.selectedRangeIds, previous),
      };
    }
    case "redo": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return {
        ...state,
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_CAP),
        future: rest,
        revision: state.revision + 1,
        selectedNoteIds: pruneNoteSelection(state.selectedNoteIds, next),
        selectedRangeIds: pruneRangeSelection(state.selectedRangeIds, next),
      };
    }
    default:
      return applyOperation(state, action);
  }
}

function toggleMembership(current, incoming) {
  const set = new Set(current);
  for (const id of incoming) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }
  return [...set];
}

function pruneNoteSelection(ids, doc) {
  const present = new Set(doc.notes.map((n) => n.id));
  return ids.filter((id) => present.has(id));
}

function pruneRangeSelection(ids, doc) {
  const present = new Set(doc.ranges.map((r) => r.id));
  return ids.filter((id) => present.has(id));
}

export { cloneEditorDoc };
