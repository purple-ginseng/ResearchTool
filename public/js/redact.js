/* Redaction for Help › Copy diagnostics, shared by the server (lib/diagnostics.js, which first replaces the paths it
   knows: workspace, external projects, backup folder, temporary and home folder) and the page (public/js/diagnostics.js).
   redact(s): the user name of a URL (a proxy: https://<user>@host), e-mail addresses <email>, any user's home
   (/Users/x, /home/x, C:\Users\x - also "Jane Doe" when a separator follows) <home>, a drive or share (/Volumes/x,
   /mnt/x, /media/user/x, \\server\share\folder) <volume> / <share>, and API keys and tokens (sk-..., ghp_..., xai-...,
   AIza..., "Bearer x", key=value, long hex / base64 runs) <secret>.
   quoted(s): for the error messages of the page, which can quote what was typed or read (JSON.parse of a note:
   'Unexpected token ..., "my private"... is not valid JSON'): a quoted piece with a space, a non-ASCII letter or more
   than 12 characters becomes "<text>" - not an option name ('--effort') or a short word ('boom'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTRedact = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const URL_USER = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"`<>]+@/gi;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  // a name segment: one word, or words with spaces when a separator follows ("/Users/Jane Doe/x" - not "/Users/jane ok")
  const SEG = (sep) => `(?:[^${sep}\\s'"\`:;,)]+(?: [^${sep}\\s'"\`:;,)]+)*(?=${sep === '/' ? '\\/' : '\\\\'})|[^${sep}\\s'"\`:;,)]+)`;
  const OTHER_HOME = new RegExp(`(?:\\/Users|\\/home)\\/${SEG('/')}|\\/root(?![\\w.-])|[A-Za-z]:\\\\(?:Users|Documents\\x20and\\x20Settings)\\\\${SEG('\\\\')}`, 'gi');
  const VOLUME = new RegExp(`\\/(?:Volumes|mnt)\\/${SEG('/')}|\\/(?:run\\/)?media\\/[^/\\s'"\`:;,)]+\\/${SEG('/')}`, 'g');
  const SHARE = /\\\\[^\\\s'"`:;,)]+\\[^\\\s'"`:;,)]+(?:\\[^\\\s'"`:;,)]+)?/g; // \\server\share\folder
  const SECRETS = [
    /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\b((?:x-)?api[_-]?key|(?:access|auth|refresh)?[_-]?token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|<secret>)[^\s"',;]{4,}/gi,
    /\b(?:sk-(?:ant-|proj-)?|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xai-|glpat-|hf_)[A-Za-z0-9_-]{8,}/g,
    /\bAIza[0-9A-Za-z_-]{20,}/g,
    /\b[0-9a-fA-F]{32,}\b/g,
    /(?<![\w/+-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g,
  ];
  function redact(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(URL_USER, '$1<user>@').replace(EMAIL, '<email>').replace(OTHER_HOME, '<home>').replace(VOLUME, '<volume>').replace(SHARE, '<share>');
    s = s.replace(SECRETS[0], '$1 <secret>').replace(SECRETS[1], '$1$2<secret>');
    for (const re of SECRETS.slice(2)) s = s.replace(re, '<secret>');
    return s;
  }
  const QUOTED = /"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”|‘([^’\n]*)’/g;
  function quoted(text) {
    return String(text == null ? '' : text).replace(QUOTED, (m, a, b, c, d) => {
      const q = a ?? b ?? c ?? d ?? '';
      if (/^-{1,2}[A-Za-z]/.test(q) || /^<\w+>$/.test(q)) return m;
      return q.length > 12 || /\s/.test(q) || /[^\x00-\x7f]/.test(q) ? m[0] + '<text>' + m[m.length - 1] : m;
    });
  }
  return { redact, quoted };
});
