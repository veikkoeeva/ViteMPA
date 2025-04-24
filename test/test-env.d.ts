import { Env } from "../cloudflare/env.d.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Cloudflare.Env {}
}
