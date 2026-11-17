import { createWebAiHandlers } from '../../server/web-ai-http.mjs';

// Vercel's Node.js Web Standard handler. Authentication is independent of demo roles.
export default { fetch: request => createWebAiHandlers().session(request) };
