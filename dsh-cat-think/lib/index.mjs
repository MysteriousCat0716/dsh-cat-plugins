/**
 * dsh-cat-think - host half.
 *
 * Everything this plugin does is browser-side (see lib/client.js); the host
 * entry exists only so the bundle patch can register a row that the web client
 * loader picks up. Keep it free of services so it never blocks boot.
 */

/** Plugin identity for cordis rows. */
export const name = "dsh-cat-think";

/** No host services are required. */
export const inject = [];

/** Nothing to do on the host. */
export function apply() {}
