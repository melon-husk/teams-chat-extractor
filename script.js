#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] !== undefined ? match[2] : true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 8;
const MAX_BACKOFF_MS = 60000;

async function fetchJson(url, headers) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
        console.warn(`Network error (${e.message}). Retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(waitMs);
        continue;
      }
      return { ok: false, status: 0, text: e.message, json: null };
    }

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const waitMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
      console.warn(`Rate limited (status ${res.status}). Retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(waitMs);
      continue;
    }

    return { ok: res.ok, status: res.status, text, json };
  }
}

function readFailures(failuresFile) {
  try {
    const raw = fs.readFileSync(failuresFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return null;
  }
}

function writeFailures(failuresFile, failures) {
  if (failures.length === 0) {
    try { fs.rmSync(failuresFile); } catch (_) {}
    return;
  }
  fs.writeFileSync(failuresFile, JSON.stringify(failures, null, 2), 'utf-8');
}

// Incomplete downloads get a distinct filename so a `chat_*.json` file always means
// "fully downloaded" and fetched-but-truncated data is never mistaken for complete.
function saveChatFile(location, chatId, msgs, complete) {
  const chatFile = path.join(location, complete
    ? `chat_${chatId.slice(0, 6)}.json`
    : `chat_${chatId.slice(0, 6)}.partial.json`);
  try {
    fs.writeFileSync(chatFile, JSON.stringify(msgs, null, 2), 'utf-8');
    console.log(`Saved ${msgs.length} messages to ${chatFile}`);
  } catch (e) {
    console.error(`Error saving chat file ${chatFile}: ${e.message}`);
  }
}

async function downloadTeamsChats({ token, location, startDate, endDate, baseUrl, chatsOverride }) {
  const headers = { Authorization: `Bearer ${token}` };
  const failuresFile = path.join(location, 'failures.json');

  let chats;
  if (chatsOverride) {
    chats = chatsOverride;
    console.log(`Retrying ${chats.length} previously failed chat(s) from ${failuresFile}`);
  } else {
    chats = [];
    let nextUrl = `${baseUrl}/me/chats`;
    while (nextUrl) {
      console.log(`Requesting chats from: ${nextUrl}`);
      const resp = await fetchJson(nextUrl, headers);
      console.log(`Chats response status: ${resp.status}`);
      if (!resp.ok) {
        console.error(`Error fetching chats: ${resp.text}`);
        return { ok: false, incompleteCount: 0, totalChats: 0 };
      }
      const pageChats = Array.isArray(resp.json?.value) ? resp.json.value : [];
      console.log(`Number of chats found in page: ${pageChats.length}`);
      chats = chats.concat(pageChats);
      nextUrl = resp.json?.['@odata.nextLink'] || null;
    }
    console.log(`Total number of chats found: ${chats.length}`);
  }

  const startDt = startDate ? new Date(startDate) : null;
  const endDt = endDate ? new Date(endDate) : null;
  function applyFilter(msgs) {
    if (!startDt && !endDt) return msgs;
    return msgs.filter((msg) => {
      const msgDt = msg.createdDateTime ? new Date(msg.createdDateTime) : null;
      if (startDt && msgDt && msgDt < startDt) return false;
      if (endDt && msgDt && msgDt > endDt) return false;
      return true;
    });
  }

  const failures = [];
  // Tracks the chat currently being fetched so a Ctrl+C can flush what's been
  // downloaded so far instead of losing it.
  const current = { chatId: null, msgs: [] };
  let interrupted = false;

  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    console.warn('\nSIGINT received — flushing in-progress chat before exit...');

    if (current.chatId) {
      saveChatFile(location, current.chatId, applyFilter(current.msgs), false);
      failures.push({ id: current.chatId, error: 'Interrupted by SIGINT', messagesFetched: current.msgs.length });

      const idx = chats.findIndex((c) => c.id === current.chatId);
      for (const c of chats.slice(idx + 1)) {
        failures.push({ id: c.id, error: 'Not attempted (interrupted)', messagesFetched: 0 });
      }
    }

    writeFailures(failuresFile, failures);
    console.warn(`Progress saved. ${failures.length} chat(s) recorded in ${failuresFile} — run with --retry to resume.`);
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  for (const chat of chats) {
    const chatId = chat.id;
    current.chatId = chatId;
    current.msgs = [];
    let complete = true;
    let lastError = null;

    try {
      let msgsNextUrl = `${baseUrl}/me/chats/${chatId}/messages`;
      while (msgsNextUrl) {
        console.log(`Requesting messages for chat ${chatId} from: ${msgsNextUrl}`);
        const resp = await fetchJson(msgsNextUrl, headers);
        console.log(`Messages response status for chat ${chatId}: ${resp.status}`);
        if (!resp.ok) {
          console.error(`Error fetching messages for chat ${chatId}: ${resp.text}`);
          complete = false;
          lastError = `HTTP ${resp.status}: ${resp.text}`;
          break;
        }
        const pageMsgs = Array.isArray(resp.json?.value) ? resp.json.value : [];
        console.log(`Number of messages in page for chat ${chatId}: ${pageMsgs.length}`);
        current.msgs = current.msgs.concat(pageMsgs);
        msgsNextUrl = resp.json?.['@odata.nextLink'] || null;
      }
    } catch (e) {
      console.error(`Unexpected error fetching messages for chat ${chatId}: ${e.message}`);
      complete = false;
      lastError = e.message;
    }
    console.log(`Total number of messages fetched for chat ${chatId}: ${current.msgs.length}${complete ? '' : ' (incomplete)'}`);

    const filteredMsgs = applyFilter(current.msgs);
    saveChatFile(location, chatId, filteredMsgs, complete);

    if (!complete) {
      failures.push({ id: chatId, error: lastError, messagesFetched: current.msgs.length });
      console.warn(`Chat ${chatId} was NOT fully downloaded.`);
    }
  }

  current.chatId = null;
  process.removeListener('SIGINT', onSigint);

  writeFailures(failuresFile, failures);

  if (failures.length > 0) {
    console.warn(`${failures.length} of ${chats.length} chat(s) were only partially downloaded.`);
    console.warn(`Their IDs were saved to ${failuresFile} — run with --retry to retry just those.`);
  }

  return { ok: true, incompleteCount: failures.length, totalChats: chats.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token;
  const startDate = args.start;
  const endDate = args.end;
  const location = args.out || './data';
  const baseUrl = process.env.MS_GRAPH_API_BASE_URL || 'https://graph.microsoft.com/v1.0';

  if (!token) {
    console.error('Missing required --token="..." argument');
    process.exit(1);
  }

  fs.mkdirSync(location, { recursive: true });

  let chatsOverride;
  if (args.retry) {
    const failuresFile = path.join(location, 'failures.json');
    const failures = readFailures(failuresFile);
    if (!failures) {
      console.error(`No failures file found at ${failuresFile} — nothing to retry.`);
      process.exit(1);
    }
    if (failures.length === 0) {
      console.log('Failures file is empty — nothing to retry.');
      process.exit(0);
    }
    chatsOverride = failures.map((f) => ({ id: f.id }));
  }

  try {
    const result = await downloadTeamsChats({ token, location, startDate, endDate, baseUrl, chatsOverride });
    if (!result.ok) {
      console.error('Download failed.');
      process.exit(1);
    }
    if (result.incompleteCount > 0) {
      console.log(`Done, but ${result.incompleteCount} of ${result.totalChats} chat(s) are incomplete (see .partial.json files). Re-run to retry them.`);
      process.exit(2);
    }
    console.log('Chats downloaded successfully.');
  } catch (e) {
    console.error('Exception during downloadTeamsChats:', e);
    process.exit(1);
  }
}

main();
