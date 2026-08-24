#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');

// Minimal .env loader (no dotenv dependency) — real env vars always win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] !== undefined ? match[2] : true;
  }
  return args;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function loadMessages(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^chat_.*\.json$/.test(f));
  const messages = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    } catch (e) {
      console.warn(`Skipping ${file}: invalid JSON (${e.message})`);
      continue;
    }
    if (Array.isArray(parsed)) messages.push(...parsed);
  }
  return messages;
}

function buildRows(messages) {
  const personRows = [];
  const chatRows = [];
  const messageRows = [];
  const replyRows = [];
  const mentionRows = [];
  const reactionRows = [];
  const attachmentRows = [];
  const seenPersons = new Set();
  const seenChats = new Set();

  for (const msg of messages) {
    const personId = msg.from?.user?.id || null;
    const displayName = msg.from?.user?.displayName || null;

    if (personId && !seenPersons.has(personId)) {
      seenPersons.add(personId);
      personRows.push({ personId, displayName });
    }
    if (msg.chatId && !seenChats.has(msg.chatId)) {
      seenChats.add(msg.chatId);
      chatRows.push({ chatId: msg.chatId });
    }

    messageRows.push({
      id: msg.id,
      chatId: msg.chatId,
      createdDateTime: msg.createdDateTime,
      messageType: msg.messageType || null,
      contentType: msg.body?.contentType || null,
      content: msg.body?.content || null,
      webUrl: msg.webUrl || null,
      deleted: !!msg.deletedDateTime,
      personId,
    });

    if (msg.replyToId) {
      replyRows.push({ id: msg.id, replyToId: msg.replyToId });
    }

    for (const mention of msg.mentions || []) {
      const mp = mention.mentioned?.user;
      if (mp?.id) {
        mentionRows.push({ messageId: msg.id, personId: mp.id, displayName: mp.displayName || null });
      }
    }

    for (const reaction of msg.reactions || []) {
      const rp = reaction.user?.user;
      if (rp?.id) {
        reactionRows.push({
          messageId: msg.id,
          personId: rp.id,
          type: reaction.reactionType,
          displayName: rp.displayName || null,
          at: reaction.createdDateTime || null,
        });
      }
    }

    for (const att of msg.attachments || []) {
      if (att.id) {
        attachmentRows.push({
          messageId: msg.id,
          attachmentId: att.id,
          name: att.name || null,
          contentUrl: att.contentUrl || null,
          contentType: att.contentType || null,
        });
      }
    }
  }

  return { personRows, chatRows, messageRows, replyRows, mentionRows, reactionRows, attachmentRows };
}

const CONSTRAINTS = [
  'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT chat_id IF NOT EXISTS FOR (c:Chat) REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT message_id IF NOT EXISTS FOR (m:Message) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT attachment_id IF NOT EXISTS FOR (a:Attachment) REQUIRE a.id IS UNIQUE',
];

const QUERIES = {
  persons: `
    UNWIND $rows AS row
    MERGE (p:Person {id: row.personId})
    ON CREATE SET p.displayName = row.displayName
    ON MATCH SET p.displayName = coalesce(row.displayName, p.displayName)
  `,
  chats: `
    UNWIND $rows AS row
    MERGE (c:Chat {id: row.chatId})
  `,
  messages: `
    UNWIND $rows AS row
    MERGE (m:Message {id: row.id})
    SET m.chatId = row.chatId,
        m.createdDateTime = datetime(row.createdDateTime),
        m.messageType = row.messageType,
        m.contentType = row.contentType,
        m.content = row.content,
        m.webUrl = row.webUrl,
        m.deleted = row.deleted
    WITH m, row
    MATCH (c:Chat {id: row.chatId})
    MERGE (m)-[:IN_CHAT]->(c)
    WITH m, row
    WHERE row.personId IS NOT NULL
    MATCH (p:Person {id: row.personId})
    MERGE (p)-[:SENT]->(m)
  `,
  replies: `
    UNWIND $rows AS row
    MATCH (m:Message {id: row.id})
    MERGE (parent:Message {id: row.replyToId})
    MERGE (m)-[:REPLY_TO]->(parent)
  `,
  mentions: `
    UNWIND $rows AS row
    MERGE (p:Person {id: row.personId})
    ON CREATE SET p.displayName = row.displayName
    WITH p, row
    MATCH (m:Message {id: row.messageId})
    MERGE (m)-[:MENTIONS]->(p)
  `,
  reactions: `
    UNWIND $rows AS row
    MERGE (p:Person {id: row.personId})
    WITH p, row
    MATCH (m:Message {id: row.messageId})
    MERGE (p)-[:REACTED {type: row.type, at: row.at}]->(m)
  `,
  attachments: `
    UNWIND $rows AS row
    MERGE (a:Attachment {id: row.attachmentId})
    SET a.name = row.name, a.contentUrl = row.contentUrl, a.contentType = row.contentType
    WITH a, row
    MATCH (m:Message {id: row.messageId})
    MERGE (m)-[:HAS_ATTACHMENT]->(a)
  `,
};

async function resetDatabase(driver, database) {
  console.log('--reset: deleting all existing nodes and relationships...');
  // CALL {...} IN TRANSACTIONS requires an auto-commit (implicit) transaction —
  // driver.executeQuery() uses a managed/explicit transaction, so use a plain session here.
  const session = driver.session({ database });
  try {
    await session.run('MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS');
  } finally {
    await session.close();
  }
  console.log('Database cleared.');
}

async function runBatched(driver, database, label, rows, batchSize, query) {
  if (rows.length === 0) return;
  const batches = chunk(rows, batchSize);
  let done = 0;
  for (const batch of batches) {
    await driver.executeQuery(query, { rows: batch }, { database });
    done += batch.length;
    console.log(`${label}: ${done}/${rows.length}`);
  }
}

async function main() {
  loadDotEnv(path.join(__dirname, '.env'));
  const args = parseArgs(process.argv.slice(2));

  const uri = args.uri || process.env.NEO4J_URI;
  const user = args.user || process.env.NEO4J_USERNAME || process.env.NEO4J_USER || 'neo4j';
  const password = args.password || process.env.NEO4J_PASSWORD;
  // Leave undefined (rather than defaulting to 'neo4j') so the driver falls back to
  // whatever the server's actual default database is — Aura instances don't always
  // name it 'neo4j'.
  const database = args.database || process.env.NEO4J_DATABASE || undefined;
  const dataDir = args.dir || './data';
  const batchSize = parseInt(args.batch, 10) || 500;

  if (!uri || !password) {
    console.error('Missing Neo4j credentials. Set NEO4J_URI/NEO4J_PASSWORD in .env, or pass --uri/--password.');
    process.exit(1);
  }

  const messages = loadMessages(dataDir);
  console.log(`Loaded ${messages.length} messages from ${dataDir}`);
  if (messages.length === 0) return;

  const { personRows, chatRows, messageRows, replyRows, mentionRows, reactionRows, attachmentRows } =
    buildRows(messages);

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  try {
    const serverInfo = await driver.getServerInfo();
    console.log('Connected to Neo4j:', serverInfo.address, `(database: ${database || 'default'})`);

    if (args.reset) {
      await resetDatabase(driver, database);
    }

    for (const constraint of CONSTRAINTS) {
      await driver.executeQuery(constraint, {}, { database });
    }

    await runBatched(driver, database, 'Persons', personRows, batchSize, QUERIES.persons);
    await runBatched(driver, database, 'Chats', chatRows, batchSize, QUERIES.chats);
    await runBatched(driver, database, 'Messages', messageRows, batchSize, QUERIES.messages);
    await runBatched(driver, database, 'Replies', replyRows, batchSize, QUERIES.replies);
    await runBatched(driver, database, 'Mentions', mentionRows, batchSize, QUERIES.mentions);
    await runBatched(driver, database, 'Reactions', reactionRows, batchSize, QUERIES.reactions);
    await runBatched(driver, database, 'Attachments', attachmentRows, batchSize, QUERIES.attachments);

    console.log('Done.');
  } finally {
    await driver.close();
  }
}

main().catch((e) => {
  console.error('Load failed:', e.message);
  process.exit(1);
});
