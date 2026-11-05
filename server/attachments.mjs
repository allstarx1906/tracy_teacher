import { createHash } from 'node:crypto';
import { assertAttachmentUploadHeaders as assertAttachmentUploadHeadersFromOrigin } from './request-origin.mjs';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_ASSIGNMENT = 10;

const EXT_BY_MIME = {
  'image/jpeg': new Set(['jpg', 'jpeg']),
  'image/png': new Set(['png']),
  'image/webp': new Set(['webp']),
  'application/pdf': new Set(['pdf']),
  'application/msword': new Set(['doc']),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': new Set(['docx']),
};

export function sanitizeAttachmentBasename(name) {
  let base = String(name || 'file').replace(/\\/g, '/');
  const slash = base.lastIndexOf('/');
  if (slash >= 0) base = base.slice(slash + 1);
  base = base.replace(/\0/g, '').trim();
  if (!base || base === '.' || base === '..') base = 'file';
  base = base.replace(/[^\w.\- ()àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/gi, '_');
  if (base.length > 180) {
    const dot = base.lastIndexOf('.');
    if (dot > 0) {
      const ext = base.slice(dot);
      base = base.slice(0, 180 - ext.length) + ext;
    } else {
      base = base.slice(0, 180);
    }
  }
  return base || 'file';
}

function extFromName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function startsWith(buf, sig, offset = 0) {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function looksLikeHtmlOrSvg(buf) {
  const head = buf.slice(0, Math.min(buf.length, 512)).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
  if (head.startsWith('<svg') || head.startsWith('<?xml') && head.includes('<svg')) return true;
  return false;
}

function isZip(buf) {
  return startsWith(buf, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(buf, [0x50, 0x4b, 0x07, 0x08]);
}

/** Bounded ZIP central-directory scan (no decompress). */
function zipCentralDirectoryHasWordPath(buf) {
  if (buf.length < 22) return false;
  const maxComment = Math.min(buf.length, 65535);
  for (let commentLen = 0; commentLen <= maxComment; commentLen++) {
    const endPos = buf.length - 22 - commentLen;
    if (endPos < 0) break;
    if (!startsWith(buf, [0x50, 0x4b, 0x05, 0x06], endPos)) continue;
    const cdSize = buf.readUInt32LE(endPos + 12);
    const cdOffset = buf.readUInt32LE(endPos + 16);
    if (cdOffset + cdSize > buf.length) continue;
    const cdEnd = Math.min(buf.length, cdOffset + cdSize);
    let ptr = cdOffset;
    while (ptr + 46 <= cdEnd) {
      if (!startsWith(buf, [0x50, 0x4b, 0x01, 0x02], ptr)) break;
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLenEntry = buf.readUInt16LE(ptr + 32);
      const nameStart = ptr + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > cdEnd) break;
      const name = buf.slice(nameStart, nameEnd).toString('utf8');
      if (name.startsWith('word/') || name === '[Content_Types].xml') return true;
      ptr = nameEnd + extraLen + commentLenEntry;
    }
  }
  return false;
}

function docxLooksValid(buf) {
  if (!isZip(buf)) return false;
  if (buf.length <= 8192) {
    const sample = buf.slice(0, Math.min(buf.length, 8192)).toString('binary');
    return sample.includes('word/') || sample.includes('[Content_Types].xml');
  }
  return zipCentralDirectoryHasWordPath(buf);
}

function detectMimeFromBuffer(buf) {
  if (looksLikeHtmlOrSvg(buf)) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12) {
    const tag = buf.slice(8, 12).toString('ascii');
    if (tag === 'WEBP') return 'image/webp';
  }
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0])) return 'application/msword';
  if (docxLooksValid(buf)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return null;
}

/** SHA-256 hex digest of validated attachment bytes (matches client fileContentFingerprint). */
export function attachmentContentDigest(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function validateAttachmentBuffer(buf, originalName, declaredMime = '') {
  if (!buf || !buf.length) {
    return { ok: false, error: 'Tệp rỗng.' };
  }
  if (buf.length > ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: 'Tệp quá lớn (tối đa 20 MB).' };
  }
  const ext = extFromName(originalName);
  const detected = detectMimeFromBuffer(buf);
  if (!detected) {
    return { ok: false, error: 'Định dạng tệp không được hỗ trợ.' };
  }
  const allowedExts = EXT_BY_MIME[detected];
  if (allowedExts && ext && !allowedExts.has(ext)) {
    return { ok: false, error: 'Phần mở rộng tệp không khớp nội dung.' };
  }
  const dm = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  const genericOrAbsentMime = !dm || dm === 'application/octet-stream';
  if (
    !genericOrAbsentMime
    && dm !== detected
    && !(detected === 'image/jpeg' && dm === 'image/jpg')
  ) {
    return { ok: false, error: 'Loại MIME không khớp nội dung tệp.' };
  }
  return { ok: true, mime: detected, filename: sanitizeAttachmentBasename(originalName) };
}

export function encodeContentDisposition(filename, inline = false) {
  const safe = sanitizeAttachmentBasename(filename).replace(/"/g, '');
  const type = inline ? 'inline' : 'attachment';
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${safe.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`;
}

export async function readBinaryBody(req, limit = ATTACHMENT_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function assertAttachmentUploadHeaders(req, hostHeader, csrfCookie, csrfHeader, publicOrigin) {
  return assertAttachmentUploadHeadersFromOrigin(req, hostHeader, csrfCookie, csrfHeader, publicOrigin);
}

export function validateTeacherAttachmentIdList(state, teacherAccountId, attachmentIds) {
  if (!Array.isArray(attachmentIds)) {
    return { ok: false, error: 'Danh sách tệp đính kèm không hợp lệ.' };
  }
  if (attachmentIds.length > ATTACHMENT_MAX_PER_ASSIGNMENT) {
    return { ok: false, error: `Tối đa ${ATTACHMENT_MAX_PER_ASSIGNMENT} tệp mỗi bài tập.` };
  }
  const seen = new Set();
  for (const id of attachmentIds) {
    if (typeof id !== 'string' || !id) {
      return { ok: false, error: 'Mã tệp đính kèm không hợp lệ.' };
    }
    if (seen.has(id)) {
      return { ok: false, error: 'Tệp đính kèm bị trùng.' };
    }
    seen.add(id);
    const meta = state.attachmentMeta?.[id];
    if (!meta) {
      return { ok: false, error: 'Tệp đính kèm không tồn tại hoặc chưa được tải lên.' };
    }
    if (meta.ownerAccountId !== teacherAccountId) {
      return { ok: false, error: 'Không thể dùng tệp không thuộc giáo viên.' };
    }
  }
  return { ok: true, value: [...attachmentIds] };
}
