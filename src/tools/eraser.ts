/** Eraser — pencil that stages transparent (0). */
import type { Rgba, ToolId } from '../core/contracts';
import { StrokeTool } from './tool';

export class EraserTool extends StrokeTool {
  readonly id: ToolId = 'eraser';
  readonly label = 'eraser';
  readonly hotkey = 'e';

  protected override readonly commitLabel = 'erase';

  protected override strokeColor(): Rgba {
    return 0;
  }
}
