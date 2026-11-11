import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  EXAM_SKILL,
  EXAM_QUESTION_TYPE,
  pickExamMediaAttachmentFromSnapshot,
  buildAssignmentMediaSnapshot,
} from '../dist/exam-domain.js';
import { startBaTestServer, api, teacherSetup } from './ba-test-helpers.mjs';
import { installBaDomEnvironment } from './helper-browser-window.mjs';
import { renderExamComposeView } from '../dist/exam-ui-teacher.js';
import { renderExamSourceReadView } from '../dist/exam-ui-source.js';
import { renderExamTakeView } from '../dist/exam-ui-student.js';

function minimalMp3Buffer(tag = 0) {
  return Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    tag,
  ]);
}

async function uploadAudio(ctx, tJar, buf, name = 'clip.mp3') {
  const res = await fetch(`${ctx.base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: Object.entries(tJar).map(([k, v]) => `${k}=${v}`).join('; '),
      'content-type': 'audio/mpeg',
      'x-bn-csrf': tJar.bn_csrf,
      'x-bn-filename': encodeURIComponent(name),
    },
    body: buf,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.id;
}

test('domain: media snapshot resolves frozen paper and group audio ids', () => {
  const version = {
    audioAttachmentId: null,
    audioState: 'pending',
    mediaBindings: {
      paper: { audioAttachmentId: 'a-paper', frozenAudioAttachmentId: 'a-paper' },
      groups: {
        g1: { audioAttachmentId: 'a-g1', frozenAudioAttachmentId: 'a-g1' },
      },
    },
  };
  const snap = buildAssignmentMediaSnapshot(version);
  assert.equal(snap.audioAttachmentId, 'a-paper');
  assert.equal(snap.audioState, 'available');
  assert.equal(pickExamMediaAttachmentFromSnapshot(snap, { groupId: 'g1' }), 'a-g1');
  assert.equal(pickExamMediaAttachmentFromSnapshot(snap), 'a-paper');
});

test('API: skill saved on draft persists through publish', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const blank = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Skill draft' },
  });
  const draftId = blank.data.draftId;
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: 'Skill draft',
      questions: [{
        id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'W',
        skill: EXAM_SKILL.WRITING,
        questionType: EXAM_QUESTION_TYPE.ESSAY,
        points: 5,
      }],
      sections: [{ id: 's1', title: 'P', order: 1 }],
      passages: [],
      teacherConfirmedReview: true,
      baseRevision: 0,
    },
  });
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/publish`, { method: 'POST', body: {} });
  const versionId = pub.data.versionId;
  const src = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/compose-source?skills=${EXAM_SKILL.WRITING}`);
  assert.equal(src.res.status, 200);
  assert.equal(src.data.source.questions.length, 1);
  assert.equal(src.data.source.questions[0].skill, EXAM_SKILL.WRITING);
  const miss = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/compose-source?skills=${EXAM_SKILL.LISTENING}`);
  assert.equal(miss.data.source.questions.length, 0);
});

test('API: compose-source filter query matches bank OR/AND semantics', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const versionId = randomUUID();
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push({
      id: versionId,
      teacherAccountId: teacherId,
      title: 'Mixed',
      sections: [{ id: 's1', title: 'P', order: 1 }],
      questions: [
        {
          id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'L',
          skill: EXAM_SKILL.LISTENING,
          questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
          options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1,
        },
        {
          id: 'q2', sectionId: 's1', displayNumber: '2', stemText: 'R',
          skill: EXAM_SKILL.READING,
          questionType: EXAM_QUESTION_TYPE.ESSAY,
          points: 5,
        },
      ],
      passages: [],
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
  });
  await store.close();
  const both = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/compose-source?skills=${EXAM_SKILL.LISTENING}&types=${EXAM_QUESTION_TYPE.SINGLE_CHOICE}`);
  assert.equal(both.data.source.questions.length, 1);
  assert.equal(both.data.source.questions[0].id, 'q1');
});

test('API: two sources carry distinct frozen audio bindings on append', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const audioA = await uploadAudio(ctx, tJar, minimalMp3Buffer(1), 'a.mp3');
  const audioB = await uploadAudio(ctx, tJar, minimalMp3Buffer(2), 'b.mp3');
  const gA = 'grp-a';
  const gB = 'grp-b';
  const versionSeed = async (title, gid, audioId, qid) => {
    const versionId = randomUUID();
    const { createStore } = await import('../server/store.mjs');
    const store = createStore(ctx.dataDir);
    await store.mutate((s) => {
      s.examVersions.push({
        id: versionId,
        teacherAccountId: teacherId,
        title,
        sections: [{ id: 's1', title: 'P', order: 1 }],
        passages: [{ id: gid, title: 'G', bodyText: 'Ctx' }],
        questions: [{
          id: qid, sectionId: 's1', displayNumber: '1', stemText: 'Q',
          passageId: gid, groupId: gid,
          options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1,
        }],
        audioAttachmentId: audioId,
        audioState: 'available',
        mediaRevision: 0,
        mediaBindings: {
          paper: null,
          groups: { [gid]: { audioAttachmentId: audioId, frozenAudioAttachmentId: audioId } },
        },
        publishedAt: '2025-01-01T00:00:00.000Z',
      });
    });
    await store.close();
    return versionId;
  };
  const vA = await versionSeed('Src A', gA, audioA, 'qa1');
  const vB = await versionSeed('Src B', gB, audioB, 'qb1');
  const draft = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Mix audio' },
  });
  const draftId = draft.data.draftId;
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: vA, questionIds: ['qa1'] },
  });
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: vB, questionIds: ['qb1'] },
  });
  const got = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`);
  const bindings = got.data.draft.mediaBindings?.groups || {};
  const draftGroupIds = Object.keys(bindings);
  assert.equal(draftGroupIds.length, 2);
  const attSet = new Set(draftGroupIds.map((k) => bindings[k].frozenAudioAttachmentId || bindings[k].audioAttachmentId));
  assert.equal(attSet.size, 2);
  assert.ok(attSet.has(audioA));
  assert.ok(attSet.has(audioB));
});

test('API: teacher attachment preview route streams owned audio', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const audioId = await uploadAudio(ctx, tJar, minimalMp3Buffer(9), 'owned.mp3');
  const ok = await fetch(`${ctx.base}/api/teacher/attachments/${audioId}`, {
    headers: { cookie: Object.entries(tJar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  assert.equal(ok.status, 200);
  const deny = await fetch(`${ctx.base}/api/teacher/attachments/${audioId}`);
  assert.equal(deny.status, 401);
});

test('UI: compose hub exposes skill filter bar', async (t) => {
  const dom = installBaDomEnvironment(t);
  const root = dom.root;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    root.__examDispose?.();
    delete root.__examDispose;
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/summary')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          versions: [{ id: 'v1', title: 'X', questionCount: 1 }],
          banks: [],
          filterQualification: { matchingVersionCount: 1, matchingQuestionCount: 1 },
        }),
      };
    }
  };
  renderExamComposeView({ navigate: () => {}, toastErr: () => {}, toastOk: () => {} }, root);
  assert.ok(root.querySelector('[data-exam-compose-filter]'));
  assert.ok(root.querySelector('[data-exam-compose-skill]'));
});

test('UI: student take mounts authorized audio player element', async (t) => {
  const dom = installBaDomEnvironment(t);
  const root = dom.root;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    root.__examDispose?.();
    delete root.__examDispose;
  });
  let detailCalls = 0;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    if (u.includes('/assignments/a1') && method === 'GET') {
      detailCalls += 1;
      const attempt = detailCalls === 1 ? null : {
        id: 'att1', status: 'in_progress', answers: {}, revision: 0,
      };
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: {
            title: 'T',
            assignment: { id: 'a1', deliveryMode: 'online' },
            media: {
              audioAttachmentId: 'aud-1',
              mediaBindings: { paper: { audioAttachmentId: 'aud-1' } },
            },
            sections: [{ id: 's1', title: 'P', order: 1 }],
            passages: [],
            questions: [{
              id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'L',
              requiresAudio: true,
              options: [{ id: 'A', text: 'a' }],
            }],
            attempt,
          },
        }),
      };
    }
    if (u.includes('/attempts/start')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, attemptId: 'att1', deadlineAt: '2035-01-01T00:00:00.000Z' }),
      };
    }
    if (u.includes('/server-now')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, now: '2025-06-01T12:00:00.000Z' }),
      };
    }
    throw new Error(u);
  };
  renderExamTakeView({ navigate: () => {}, toastErr: () => {}, toastOk: () => {} }, root, 'a1');
  await new Promise((r) => setTimeout(r, 40));
  const player = root.querySelector('[data-exam-audio-player]');
  assert.ok(player);
  const audio = player.querySelector('audio');
  assert.ok(audio?.src?.includes('/api/student/exams/assignments/a1/audio'));
});

test('UI: source read dispose avoids document after teardown', async (t) => {
  const dom = installBaDomEnvironment(t);
  const root = dom.root;
  const originalFetch = globalThis.fetch;
  const originalDoc = globalThis.document;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDoc;
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/compose-source')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          source: { questions: [], groups: [] },
          filterQualification: { matchingQuestionCount: 0, totalQuestionCount: 0 },
        }),
      };
    }
    if (u.includes('/student-preview')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: { title: 'X', sections: [], passages: [], questions: [] },
        }),
      };
    }
    throw new Error(u);
  };
  renderExamSourceReadView({ navigate: () => {}, toastErr: () => {}, toastOk: () => {} }, root, 'v-src');
  await new Promise((r) => setTimeout(r, 20));
  globalThis.document = undefined;
  assert.doesNotThrow(() => root.__examDispose?.());
});
