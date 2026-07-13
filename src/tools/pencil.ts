/** Pencil — stages brush-sized writes along the pointer path; one command per stroke. */
import type { Rgba, ToolCtx, ToolId } from '../core/contracts';
import { StrokeTool } from './tool';

export class PencilTool extends StrokeTool {
  readonly id: ToolId = 'pencil';
  readonly label = 'pencil';
  readonly hotkey = 'b';

  protected override readonly commitLabel = 'pencil stroke';

  protected override strokeColor(ctx: ToolCtx): Rgba {
    return ctx.color;
  }
}
