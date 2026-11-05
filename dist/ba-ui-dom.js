import { planDomProp } from './model.js';
import { utcIsoToBaLocalInput, baLocalInputToUtcIso, BA_TIMEZONE } from './ba-domain.js';

function applyDomPlan(node, plan) {
  switch (plan.action) {
    case 'className':
      node.className = plan.value;
      if (node.attributes) node.attributes.className = plan.value;
      if (typeof node.setAttribute === 'function') node.setAttribute('class', plan.value);
      break;
    case 'text':
      node.textContent = plan.value;
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

function appendDomChild(node, c) {
  if (c == null) return;
  if (Array.isArray(c)) {
    for (const item of c) appendDomChild(node, item);
    return;
  }
  node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    applyDomPlan(node, planDomProp(k, v));
  }
  for (const c of children) {
    appendDomChild(node, c);
  }
  return node;
}

export function contactLabel(profile) {
  const phone = profile.phone?.trim();
  const email = profile.email?.trim();
  if (phone && email) return `${phone} · ${email}`;
  return phone || email || '— (thiếu liên hệ)';
}

/** Display/edit datetimes in configured app timezone (UTC+7), not browser local. */
export function isoToLocalInput(iso) {
  return utcIsoToBaLocalInput(iso);
}

export function localInputToIso(value) {
  return baLocalInputToUtcIso(value);
}

export function baTimezoneLabel() {
  return BA_TIMEZONE;
}
