// Static files come from dist-web/ (their headers from its _headers file).
// /api/* goes to the usage-counts Worker; paths with no file also land here
// and get the static 404.
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api/") ? env.COUNTS.fetch(request) : env.ASSETS.fetch(request);
  },
};
