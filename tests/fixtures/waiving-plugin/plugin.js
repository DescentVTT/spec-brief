// A plugin shaped like spec-harness's: reached through a subpath of a scoped
// package, exported for import only, and waiving the protected files its
// options allow - as a verified ruling would - and nothing else. The reason
// repeats what it was asked about, so a test can see the context arrive.
export default (options) => ({
  name: 'waiver',
  rules: [],
  waive: async ({ root, brief, findings, base, commit }) =>
    findings
      .filter((finding) => finding.rule === 'protected-file' && options.allow.includes(finding.path))
      .map((finding) => ({
        rule: finding.rule,
        path: finding.path,
        reason: `allowed for ${brief.id} (${brief.file}, ${brief.text.length > 0 ? 'read' : 'empty'}) at ${commit === null ? 'no commit' : commit.slice(0, 7)} from ${base ?? 'no base'}${root.length > 0 ? '' : ' nowhere'}`,
      })),
});
