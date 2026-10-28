import assert from 'node:assert/strict';
import test from 'node:test';
import { coalesceSurfaceEvents } from '../src/input-events.js';

const move = (x, buttons = 0) => ({ type: 'pointer', action: 'move', x, y: x, buttons });
const down = (x, buttons = 1) => ({ type: 'pointer', action: 'down', x, y: x, button: 0, buttons });
const up = (x) => ({ type: 'pointer', action: 'up', x, y: x, button: 0, buttons: 0 });

test('returns an empty list for missing or empty input', () => {
  assert.deepEqual(coalesceSurfaceEvents(undefined), []);
  assert.deepEqual(coalesceSurfaceEvents([]), []);
});

test('keeps only the last move of a hover run', () => {
  const events = [move(1), move(2), move(3)];
  assert.deepEqual(coalesceSurfaceEvents(events), [move(3)]);
});

test('keeps the first and last moves and a small sample while dragging', () => {
  const events = [down(0), ...Array.from({ length: 20 }, (_, index) => move(index + 1, 1)), up(21)];
  const result = coalesceSurfaceEvents(events);
  const moves = result.filter((event) => event.action === 'move');

  assert.equal(result[0].action, 'down');
  assert.equal(result.at(-1).action, 'up');
  assert.equal(moves.length, 4);
  assert.equal(moves[0].x, 1);
  assert.equal(moves.at(-1).x, 20);
  assert.deepEqual(moves.map((event) => event.x), [...new Set(moves.map((event) => event.x))].sort((a, b) => a - b));
});

test('keeps a short drag intact', () => {
  const events = [down(0), move(1, 1), move(2, 1), move(3, 1), up(4)];
  assert.deepEqual(coalesceSurfaceEvents(events), events);
});

test('preserves non-move events and their order', () => {
  const events = [
    move(1),
    move(2),
    down(2),
    move(3, 1),
    move(4, 1),
    up(4),
    { type: 'wheel', x: 4, y: 4, deltaX: 0, deltaY: 10 },
    { type: 'key', action: 'down', key: 'Enter', code: 'Enter' },
    { type: 'text', text: 'x' },
    move(5),
    move(6),
  ];
  const result = coalesceSurfaceEvents(events);
  assert.deepEqual(result.map((event) => (
    event.type === 'pointer' && event.action === 'move' && event.buttons === 0 ? `move:${event.x}` : event.type
  )), ['move:2', 'pointer', 'pointer', 'pointer', 'pointer', 'wheel', 'key', 'text', 'move:6']);
  assert.equal(result[1].action, 'down');
  assert.equal(result[4].action, 'up');
  assert.equal(result.at(-1).x, 6);
});
