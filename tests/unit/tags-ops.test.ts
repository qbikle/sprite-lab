/** core/commands/tags-ops — tag commands: apply→revert round-trips + history. */
import { describe, expect, it } from 'vitest';
import type { Tag } from '../../src/core/contracts';
import { AddTag, RemoveTag, UpdateTag } from '../../src/core/commands/tags-ops';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';

const WALK: Tag = { name: 'walk', from: 0, to: 1, mode: 'loop' };
const RUN: Tag = { name: 'run', from: 2, to: 3, mode: 'pingpong' };

function seededDoc(): SpriteDoc {
  const doc = SpriteDoc.blank(2, 2, 't');
  doc.tags = [{ ...WALK }, { ...RUN }];
  return doc;
}

describe('AddTag', () => {
  it('pushes a copy on apply, removes it on revert, re-adds on redo', () => {
    const doc = SpriteDoc.blank(2, 2, 't');
    const source: Tag = { name: 'sleep', from: 0, to: 0, mode: 'hold' };
    const cmd = new AddTag(source);

    cmd.apply(doc);
    expect(doc.tags).toEqual([{ name: 'sleep', from: 0, to: 0, mode: 'hold' }]);
    source.name = 'mutated'; // constructor copied — the doc tag is unaffected
    expect(doc.tags[0]?.name).toBe('sleep');

    cmd.revert(doc);
    expect(doc.tags).toEqual([]);
    cmd.apply(doc);
    expect(doc.tags).toEqual([{ name: 'sleep', from: 0, to: 0, mode: 'hold' }]);
  });
});

describe('RemoveTag', () => {
  it('removes at index and revert reinserts at the same position', () => {
    const doc = seededDoc();
    const before = doc.tags.map((t) => ({ ...t }));
    const cmd = new RemoveTag(0);

    cmd.apply(doc);
    expect(doc.tags).toEqual([RUN]);
    cmd.revert(doc);
    expect(doc.tags).toEqual(before);
    cmd.apply(doc);
    expect(doc.tags).toEqual([RUN]);
  });

  it('throws on a bad index', () => {
    expect(() => new RemoveTag(5).apply(seededDoc())).toThrow(RangeError);
  });
});

describe('UpdateTag', () => {
  it('replaces at index; revert restores the original; redo-stable', () => {
    const doc = seededDoc();
    const next: Tag = { name: 'sprint', from: 1, to: 3, mode: 'hold' };
    const cmd = new UpdateTag(1, next);

    cmd.apply(doc);
    expect(doc.tags[1]).toEqual(next);
    cmd.revert(doc);
    expect(doc.tags[1]).toEqual(RUN);
    cmd.apply(doc);
    expect(doc.tags[1]).toEqual(next);
    cmd.revert(doc);
    expect(doc.tags[1]).toEqual(RUN);
  });

  it('throws on a bad index', () => {
    expect(() => new UpdateTag(9, WALK).apply(seededDoc())).toThrow(RangeError);
  });
});

describe('history integration', () => {
  it('add → update → remove jumps 0→end with identical tag state', () => {
    const doc = SpriteDoc.blank(2, 2, 't');
    const h = new History(doc, new Bus());

    h.commit(new AddTag(WALK));
    h.commit(new AddTag(RUN));
    h.commit(new UpdateTag(0, { name: 'walk2', from: 0, to: 2, mode: 'hold' }));
    h.commit(new RemoveTag(1));
    const final = JSON.stringify(doc.tags);

    h.jumpTo(0);
    expect(doc.tags).toEqual([]);
    h.jumpTo(99);
    expect(JSON.stringify(doc.tags)).toBe(final);
    h.jumpTo(2);
    expect(doc.tags).toEqual([WALK, RUN]);
    h.jumpTo(4);
    expect(JSON.stringify(doc.tags)).toBe(final);
  });
});
