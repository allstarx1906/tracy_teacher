import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planDomProp, safeText } from '../dist/model.js';
import { installBaDomEnvironment, findDomNodes, aggregateDomTextContent } from './helper-browser-window.mjs';

/** Same child wiring as dist/app.js `el` (does not flatten array children). */
function appEl(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    const plan = planDomProp(k, v);
    switch (plan.action) {
      case 'className':
        node.className = plan.value;
        break;
      case 'text':
        node.textContent = safeText(plan.value);
        break;
      case 'property':
        node[plan.name] = plan.value;
        break;
      case 'listener':
        node.addEventListener(plan.event, plan.value);
        break;
      case 'booleanProperty':
        node[plan.name] = plan.value;
        if (plan.value) node.setAttribute(plan.name, '');
        else node.removeAttribute(plan.name);
        break;
      case 'attribute':
        node.setAttribute(plan.name, plan.value);
        break;
      default:
        break;
    }
  }
  for (const ch of children) {
    if (ch == null) continue;
    if (typeof ch === 'string') node.appendChild(document.createTextNode(ch));
    else node.appendChild(ch);
  }
  return node;
}

test('assignments teacher toolbar uses variadic el children (not array)', (t) => {
  installBaDomEnvironment(t);
  const row = appEl('div', { className: 'btn-row', style: 'margin-bottom:0.75rem' },
    appEl('button', { type: 'button', className: 'btn btn-secondary' }, 'Giao từ kho đề'),
  );
  assert.equal(row.childNodes.length, 1);
  assert.equal(row.childNodes[0].tagName, 'BUTTON');
  assert.ok(aggregateDomTextContent(row).includes('Giao từ kho đề'));
});

test('assignments merged list row mounts photo and online cards', (t) => {
  installBaDomEnvironment(t);
  const root = document.getElementById('app-root');
  root.appendChild(appEl('h1', { className: 'page-title' }, 'Bài tập'));
  root.appendChild(appEl('div', { className: 'card', style: 'margin-bottom:0.75rem' },
    appEl('div', { className: 'list-row' },
      appEl('div', {},
        appEl('strong', {}, 'Photo HW'),
        appEl('div', { style: 'font-size:0.85rem;color:var(--muted)' }, 'Lớp A · Hạn 01/01/2026 · Bài tập ảnh/sách'),
      ),
      appEl('button', { type: 'button', className: 'btn btn-primary' }, 'Chi tiết'),
    ),
  ));
  root.appendChild(appEl('div', { className: 'card', style: 'margin-bottom:0.75rem' },
    appEl('div', { className: 'list-row' },
      appEl('div', {},
        appEl('strong', {}, 'Online HW'),
        appEl('div', { style: 'font-size:0.85rem;color:var(--muted)' }, 'Lớp A · Hạn 02/01/2026 · Bài thi'),
      ),
      appEl('button', { type: 'button', className: 'btn btn-primary' }, 'Làm bài'),
    ),
  ));
  const buttons = findDomNodes(root, (n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, 2);
  assert.ok(aggregateDomTextContent(root).includes('Photo HW'));
  assert.ok(aggregateDomTextContent(root).includes('Online HW'));
});

test('renderAssignments source does not pass array literal to app el', () => {
  const appSrc = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const fn = appSrc.slice(appSrc.indexOf('function renderAssignments()'));
  const fnBody = fn.slice(0, fn.indexOf('\nfunction findSubmission'));
  assert.doesNotMatch(fnBody, /btn-row[^]*?\,\s*\[/);
});
