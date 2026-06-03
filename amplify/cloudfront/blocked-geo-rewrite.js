// CloudFront viewer-request function — auto-route /blocked to the per-country
// banned-region page (#679, follow-up to #202).
//
// The web app is a static export, so it can't resolve the visitor's country
// server-side. This rewrites a bare `/blocked` request to
// `/blocked?country=<ISO2>` using the CloudFront-Viewer-Country header, so a
// blocked-country visitor lands on their per-country page instead of the
// generic default. Everything else passes through untouched:
//   - non-/blocked paths
//   - a /blocked request that already carries a `country` query
//   - a missing / malformed viewer-country header (→ generic default page)
//
// Runtime: cloudfront-js-2.0. Keep to the restricted CF Functions JS subset
// (no Node APIs, ES5-flavoured). Associate as the viewer-request function on
// the distribution's default behavior — see amplify/README.md.
//
// `handler` is the required global entrypoint (CF invokes it; it is never
// called in-file) and `var` is the idiomatic CF Functions declaration — both
// disabled here since this is an edge runtime artifact, not module code.
/* eslint-disable no-var, @typescript-eslint/no-unused-vars */
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri !== '/blocked' && uri !== '/blocked/') {
    return request;
  }

  if (!request.querystring) {
    request.querystring = {};
  }
  if (request.querystring.country && request.querystring.country.value) {
    return request;
  }

  var countryHeader = request.headers['cloudfront-viewer-country'];
  if (!countryHeader || !countryHeader.value) {
    return request;
  }

  var country = countryHeader.value.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    return request;
  }

  request.querystring.country = { value: country };
  return request;
}
