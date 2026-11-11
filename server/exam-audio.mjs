import { ATTACHMENT_MAX_BYTES } from './attachments.mjs';

/** Exam listening audio — separate cap from generic attachments (still bounded). */
export const EXAM_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

const AUDIO_EXT_BY_MIME = {
  'audio/mpeg': new Set(['mp3', 'mpeg', 'mpga']),
  'audio/wav': new Set(['wav']),
  'audio/ogg': new Set(['ogg', 'oga']),
  'audio/mp4': new Set(['m4a', 'mp4']),
  'audio/x-m4a': new Set(['m4a']),
};

function startsWith(buf, sig, offset = 0) {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function extFromName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** Sniff supported exam audio MIME from bytes (no decompress). */
export function detectExamAudioMime(buf) {
  if (!buf || !buf.length) return null;
  if (startsWith(buf, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  if (startsWith(buf, [0xff, 0xfb]) || startsWith(buf, [0xff, 0xf3]) || startsWith(buf, [0xff, 0xf2])) {
    return 'audio/mpeg';
  }
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12) {
    const tag = buf.slice(8, 12).toString('ascii');
    if (tag === 'WAVE') return 'audio/wav';
  }
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (buf.length >= 12 && startsWith(buf, [0x00, 0x00, 0x00])) {
    const brand = buf.slice(4, 8).toString('ascii');
    if (brand === 'ftyp') {
      const minor = buf.slice(8, 12).toString('ascii');
      if (minor.includes('M4A') || minor.includes('mp42') || minor.includes('isom')) {
        return 'audio/mp4';
      }
    }
  }
  return null;
}

export function validateExamAudioBuffer(buf, originalName, declaredMime = '') {
  if (!buf || !buf.length) {
    return { ok: false, error: 'Tệp âm thanh rỗng.' };
  }
  if (buf.length > EXAM_AUDIO_MAX_BYTES) {
    return { ok: false, error: `Tệp âm thanh quá lớn (tối đa ${Math.floor(EXAM_AUDIO_MAX_BYTES / (1024 * 1024))} MB).` };
  }
  if (buf.length > ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: 'Tệp quá lớn.' };
  }
  const detected = detectExamAudioMime(buf);
  if (!detected) {
    return { ok: false, error: 'Định dạng âm thanh không được hỗ trợ.' };
  }
  const ext = extFromName(originalName);
  const allowedExts = AUDIO_EXT_BY_MIME[detected];
  if (allowedExts && ext && !allowedExts.has(ext)) {
    return { ok: false, error: 'Phần mở rộng tệp không khớp nội dung âm thanh.' };
  }
  const dm = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  const generic = !dm || dm === 'application/octet-stream';
  if (!generic && dm !== detected && !(detected === 'audio/mp4' && dm === 'audio/x-m4a')) {
    return { ok: false, error: 'Loại MIME không khớp nội dung âm thanh.' };
  }
  return { ok: true, mime: detected };
}

export function isExamAudioMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return m === 'audio/mpeg' || m === 'audio/wav' || m === 'audio/ogg' || m === 'audio/mp4' || m === 'audio/x-m4a';
}
