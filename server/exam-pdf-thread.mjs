import { workerData, parentPort } from 'node:worker_threads';
import { buildDraftFromPdf } from './exam-extract.mjs';

(async () => {
  try {
    const { bufferBase64, options } = workerData;
    const buffer = Buffer.from(bufferBase64, 'base64');
    const result = await buildDraftFromPdf(buffer, options);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e?.message || String(e) });
  }
})();
