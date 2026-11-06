import type { Worker } from "../controller.ts";
import type { Manifest, WorkerReference } from "../state.ts";

export interface ControllerOptions {
  parentId: string;
  location: Manifest["rex"] | undefined;
  isOwner: () => boolean;
  onWorker: (reference: WorkerReference) => void;
  onChange: (worker: Worker) => void;
}
