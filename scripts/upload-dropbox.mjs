import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// review-loop-trigger-v6: fresh timing render trigger
const token = process.env.DROPBOX_ACCESS_TOKEN;
const filePath = process.argv[2];
const dropboxPath = process.argv[3];

if (!token) throw new Error('DROPBOX_ACCESS_TOKEN is missing');
if (!filePath || !dropboxPath) throw new Error('Usage: node scripts/upload-dropbox.mjs <file> <dropbox-path>');

const stat = await fs.stat(filePath);
if (!stat.isFile() || stat.size === 0) throw new Error('Dropbox upload source is missing or empty');

const auth = { Authorization: `Bearer ${token}` };
const CHUNK = 8 * 1024 * 1024;

async function api(pathname, body, headers = {}) {
  const r = await fetch(`https://api.dropboxapi.com/2${pathname}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Dropbox ${pathname} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function uploadSmall() {
  const data = await fs.readFile(filePath);
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'overwrite', autorename: false, mute: true, strict_conflict: false })
    },
    body: data
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Dropbox upload ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function uploadSession() {
  const handle = await fs.open(filePath, 'r');
  try {
    const firstLength = Math.min(CHUNK, stat.size);
    const first = Buffer.allocUnsafe(firstLength);
    const firstRead = await handle.read(first, 0, firstLength, 0);
    if (firstRead.bytesRead !== firstLength) throw new Error('Failed to read first Dropbox chunk');

    const start = await fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ close: false }) },
      body: first
    });
    const startText = await start.text();
    if (!start.ok) throw new Error(`Dropbox session start ${start.status}: ${startText}`);
    const sessionId = JSON.parse(startText).session_id;

    let offset = firstLength;
    while (offset < stat.size) {
      const length = Math.min(CHUNK, stat.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead !== length) throw new Error(`Failed to read Dropbox chunk at ${offset}`);

      const isLast = offset + length === stat.size;
      if (isLast) {
        const result = await fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, commit: { path: dropboxPath, mode: 'overwrite', autorename: false, mute: true, strict_conflict: false } }) },
          body: buffer
        });
        const text = await result.text();
        if (!result.ok) throw new Error(`Dropbox session finish ${result.status}: ${text}`);
        return JSON.parse(text);
      }

      const append = await fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }) },
        body: buffer
      });
      if (!append.ok) throw new Error(`Dropbox session append ${append.status}: ${await append.text()}`);
      offset += length;
    }
  } finally {
    await handle.close();
  }
}

const metadata = stat.size <= 150 * 1024 * 1024 ? await uploadSmall() : await uploadSession();
console.log(JSON.stringify({ path: metadata.path_display, id: metadata.id, size: metadata.size, rev: metadata.rev }, null, 2));
