import {
  matchProjectSearchFile,
  type ProjectSearchWorkerRequest,
  type ProjectSearchWorkerResponse,
} from "./projectSearch";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProjectSearchWorkerRequest>) => void) | null;
  postMessage(message: ProjectSearchWorkerResponse): void;
};

scope.onmessage = event => {
  const request = event.data;
  if (request.type !== "search") return;
  let remaining = Math.max(0, request.limit);
  let truncated = false;
  for (let index = 0; index < request.files.length; index += 1) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const file = request.files[index]!;
    scope.postMessage({
      type: "file-start",
      requestId: request.requestId,
      index,
      relativePath: file.relativePath,
    });
    const result = matchProjectSearchFile(file, request.options, remaining);
    remaining -= result.contentMatchCount;
    if (result.truncated || remaining <= 0) truncated = true;
    scope.postMessage({ type: "file-result", requestId: request.requestId, result });
    if (result.error) {
      scope.postMessage({ type: "error", requestId: request.requestId, message: result.error });
      return;
    }
    if (result.truncated) break;
  }
  scope.postMessage({ type: "done", requestId: request.requestId, truncated });
};
