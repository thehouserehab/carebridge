import { createWebAiHandlers } from '../../server/web-ai-http.mjs';

export default { fetch: request => createWebAiHandlers().respond(request) };
