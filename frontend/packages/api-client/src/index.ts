import createClient from "openapi-fetch";
import type { paths, components } from "./schema";
export type { components, paths };
export const createApi = (headers: Record<string, string>) =>
  createClient<paths>({ baseUrl: "", headers });
