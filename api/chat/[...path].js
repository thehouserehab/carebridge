import { createWebChatHandler } from '../../server/web-chat-http.mjs';

const handle = createWebChatHandler();
export default { fetch: handle };
