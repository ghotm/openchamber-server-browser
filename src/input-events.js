const MAX_DRAG_MOVES = 4;

const isPointerMove = (event) => event?.type === 'pointer' && event.action === 'move';

const isDragging = (event) => (Number(event?.buttons) || 0) !== 0;

const sampleDrag = (run) => {
  if (run.length <= MAX_DRAG_MOVES) return run;
  const indexes = new Set();
  for (let index = 0; index < MAX_DRAG_MOVES; index += 1) {
    indexes.add(Math.round((index * (run.length - 1)) / (MAX_DRAG_MOVES - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => run[index]);
};

// A host frame can carry many pointer moves before the click it belongs to.
// One hover move is enough to place the cursor; a drag keeps a small sample
// so fast strokes still draw without making the click wait for every point.
export const coalesceSurfaceEvents = (events) => {
  if (!Array.isArray(events) || events.length === 0) return [];
  const result = [];
  for (let index = 0; index < events.length;) {
    const event = events[index];
    if (!isPointerMove(event)) {
      result.push(event);
      index += 1;
      continue;
    }
    const run = [];
    while (index < events.length && isPointerMove(events[index])) {
      run.push(events[index]);
      index += 1;
    }
    result.push(...(run.some(isDragging) ? sampleDrag(run) : [run[run.length - 1]]));
  }
  return result;
};
