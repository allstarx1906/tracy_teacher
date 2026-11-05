import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function resolveSafeDataPath(input, label) {
  if (!input || typeof input !== 'string') {
    throw new Error(`${label} is required`);
  }
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${resolved}`);
  }
  return resolved;
}

export function assertEmptyDestinationDir(destDir) {
  const resolved = path.resolve(destDir);
  if (fs.existsSync(resolved)) {
    const entries = fs.readdirSync(resolved);
    if (entries.length > 0) {
      throw new Error(`Destination must be an empty directory: ${resolved}`);
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

export function assertDistinctPaths(source, destination) {
  const src = path.resolve(source);
  const dst = path.resolve(destination);
  if (src === dst) {
    throw new Error('Source and destination must be different paths');
  }
  const intoSource = path.relative(src, dst);
  if (intoSource && !intoSource.startsWith('..') && !path.isAbsolute(intoSource)) {
    throw new Error('Destination must not be inside source');
  }
  const intoDest = path.relative(dst, src);
  if (intoDest && !intoDest.startsWith('..') && !path.isAbsolute(intoDest)) {
    throw new Error('Source must not be inside destination');
  }
}

export function assertNotSymlinkDir(dirPath, label) {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) return resolved;
  const st = fs.lstatSync(resolved);
  if (st.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${resolved}`);
  }
  return resolved;
}

export function assertNoParentTraversal(baseDir, targetPath, label) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes base directory`);
  }
}

export function hashFileSync(filePath) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

export function hashUtf8(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function assertNoSymlinkAncestorSegments(resolvedPath, label) {
  let cur = path.resolve(resolvedPath);
  const root = path.parse(cur).root;
  while (true) {
    if (fs.existsSync(cur)) {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        throw new Error(`${label} must not cross a symlink segment: ${cur}`);
      }
    }
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

export function hashDirectoryFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  assertNotSymlinkDir(dirPath, 'Directory');
  /** @type {{ relative: string, sha256: string, bytes: number }[]} */
  const manifest = [];
  for (const name of fs.readdirSync(dirPath)) {
    const src = path.join(dirPath, name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to hash symlink: ${src}`);
    }
    if (!st.isFile()) continue;
    manifest.push({
      relative: name,
      sha256: hashFileSync(src),
      bytes: st.size,
    });
  }
  return manifest;
}

export function copyDirectoryFiles(sourceDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(sourceDir)) return [];
  assertNotSymlinkDir(sourceDir, 'Source directory');
  /** @type {{ relative: string, sha256: string, bytes: number }[]} */
  const manifest = [];
  for (const name of fs.readdirSync(sourceDir)) {
    const src = path.join(sourceDir, name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlink: ${src}`);
    }
    if (!st.isFile()) continue;
    const dest = path.join(destDir, name);
    fs.copyFileSync(src, dest);
    manifest.push({
      relative: name,
      sha256: hashFileSync(dest),
      bytes: st.size,
    });
  }
  return manifest;
}

export function listBinFilesHashes(baseDir, subdir) {
  const dir = path.join(baseDir, subdir);
  return hashDirectoryFiles(dir).map((e) => ({ ...e, subdir }));
}

export function readFileHashIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to hash symlink file: ${filePath}`);
  }
  return hashFileSync(filePath);
}
