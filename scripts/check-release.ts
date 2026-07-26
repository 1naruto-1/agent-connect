import packageJson from '../package.json' with { type: 'json' };
import { assertSemVer } from '../src/semver.ts';

assertSemVer(packageJson.version, 'package.json version');
const argumentTag = process.argv[2];
const environmentTag = process.env.GITHUB_REF_NAME;
if (argumentTag && environmentTag && argumentTag !== environmentTag) {
  throw new Error(
    `Release tag conflict: CLI argument "${argumentTag}" disagrees with GITHUB_REF_NAME "${environmentTag}". Pass only one, or make them match.`,
  );
}
const tag = argumentTag || environmentTag;
if (!tag) throw new Error('Provide a release tag or set GITHUB_REF_NAME.');
// Release tags are strictly vMAJOR.MINOR.PATCH with an optional pre-release; build metadata is rejected.
if (tag.includes('+')) {
  throw new Error(`Release tag ${tag} must not contain build metadata (+); use vMAJOR.MINOR.PATCH with an optional pre-release.`);
}
if (tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version v${packageJson.version}.`);
}
console.log(`Release version ${packageJson.version} is valid.`);
