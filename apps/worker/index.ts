import { createGateway } from "../../gateway/public";

const gateway = createGateway();
export default { fetch: (request: Request) => gateway.fetch(request) };
