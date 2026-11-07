// Append a bundle id to dsh.profile.bundles in a profile package.json.
// Usage: node _add_bundle.cjs <path-to-package.json> <bundle-id>
const fs = require("node:fs");

const file = process.argv[2];
const id = process.argv[3];
if (!file || !id) {
  console.error("usage: node _add_bundle.cjs <package.json> <bundle-id>");
  process.exit(2);
}

const raw = fs.readFileSync(file, "utf8");
const pkg = JSON.parse(raw);
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes(id)) bundles.push(id);
pkg.dsh.profile.bundles = bundles;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`bundles=${bundles.length} includes=${bundles.includes(id)}`);
