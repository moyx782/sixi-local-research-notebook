import { JSDOM } from 'jsdom';

export function isLoginUrl(value) {
  const url = new URL(value);
  return /(?:^|\/)(?:login|log-in|signin|sign-in)(?:\/|\.|$)/i.test(url.pathname);
}

export function isLoginPage(resource) {
  if (!/^(text\/html|application\/xhtml\+xml)\b/.test(resource.contentType)) return false;
  const dom = new JSDOM(resource.text);
  try {
    const document = dom.window.document;
    return Boolean(document.querySelector('form input[type="password"]')) ||
      (/(?:sign\s*in|log\s*in|登录|登入)/i.test(document.title) && Boolean(document.querySelector('form')));
  } finally { dom.window.close(); }
}
