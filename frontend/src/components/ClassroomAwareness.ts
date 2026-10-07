import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

// Read-only students retain presence and instructor cursor display, but their private
// text selection need not generate 50 extra presence broadcasts per instructor edit.
export class ClassroomAwareness extends Awareness {
  constructor(doc: Y.Doc, private viewer: boolean) { super(doc); }
  override setLocalStateField(field: string, value: unknown) {
    if (this.viewer && field === "selection") return;
    super.setLocalStateField(field, value);
  }
}
