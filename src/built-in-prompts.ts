import adversarialReviewer from "../prompts/adversarial-reviewer.md" with { type: "text" }
import advisorSystem from "../prompts/advisor-system.md" with { type: "text" }
import advisorTiming from "../prompts/advisor-timing.md" with { type: "text" }
import bugAuditor from "../prompts/bug-auditor.md" with { type: "text" }
import cleanCodeAuditor from "../prompts/clean-code-auditor.md" with { type: "text" }
import designPolisher from "../prompts/design-polisher.md" with { type: "text" }
import fixerImplementer from "../prompts/fixer-implementer.md" with { type: "text" }
import fixerTestAuthor from "../prompts/fixer-test-author.md" with { type: "text" }
import fixerValidator from "../prompts/fixer-validator.md" with { type: "text" }
import goalFixer from "../prompts/goal-fixer.md" with { type: "text" }
import hunterCorrectness from "../prompts/hunter-correctness.md" with { type: "text" }
import hunterMaxReport from "../prompts/hunter-max-report.md" with { type: "text" }
import hunterMemory from "../prompts/hunter-memory.md" with { type: "text" }
import hunterPerformance from "../prompts/hunter-performance.md" with { type: "text" }
import hunterReliability from "../prompts/hunter-reliability.md" with { type: "text" }
import hunterReport from "../prompts/hunter-report.md" with { type: "text" }
import hunterSecurity from "../prompts/hunter-security.md" with { type: "text" }
import hunterSupplyChain from "../prompts/hunter-supply-chain.md" with { type: "text" }
import implementationFinalReview from "../prompts/implementation-final-review.md" with { type: "text" }
import implementationFixer from "../prompts/implementation-fixer.md" with { type: "text" }
import implementationTriage from "../prompts/implementation-triage.md" with { type: "text" }
import implementationValidator from "../prompts/implementation-validator.md" with { type: "text" }
import implementer from "../prompts/implementer.md" with { type: "text" }
import patternAuditor from "../prompts/pattern-auditor.md" with { type: "text" }
import qualityScoreReport from "../prompts/quality-score-report.md" with { type: "text" }
import qualityScorer from "../prompts/quality-scorer.md" with { type: "text" }
import reviewAdversary from "../prompts/review-adversary.md" with { type: "text" }
import reviewFixer from "../prompts/review-fixer.md" with { type: "text" }
import reviewReport from "../prompts/review-report.md" with { type: "text" }
import reviewScope from "../prompts/review-scope.md" with { type: "text" }
import reviewValidator from "../prompts/review-validator.md" with { type: "text" }
import runReporter from "../prompts/run-reporter.md" with { type: "text" }
import runtimeSafety from "../prompts/runtime-safety.md" with { type: "text" }
import securityAuditor from "../prompts/security-auditor.md" with { type: "text" }
import securityReviewer from "../prompts/security-reviewer.md" with { type: "text" }
import syncWithBase from "../prompts/sync-with-base.md" with { type: "text" }
import testEngineer from "../prompts/test-engineer.md" with { type: "text" }

/**
 * Built-in agent prompts embedded as text at bundle time, so the compiled
 * binary never reads the source tree's prompts/ directory at runtime. Every
 * file in prompts/ must have an import above and an entry here (a test in
 * agents.test.ts enforces this).
 */
export const builtInPrompts: Record<string, string> = {
  "adversarial-reviewer": adversarialReviewer,
  "advisor-system": advisorSystem,
  "advisor-timing": advisorTiming,
  "bug-auditor": bugAuditor,
  "clean-code-auditor": cleanCodeAuditor,
  "design-polisher": designPolisher,
  "fixer-implementer": fixerImplementer,
  "fixer-test-author": fixerTestAuthor,
  "fixer-validator": fixerValidator,
  "goal-fixer": goalFixer,
  "hunter-correctness": hunterCorrectness,
  "hunter-max-report": hunterMaxReport,
  "hunter-memory": hunterMemory,
  "hunter-performance": hunterPerformance,
  "hunter-reliability": hunterReliability,
  "hunter-report": hunterReport,
  "hunter-security": hunterSecurity,
  "hunter-supply-chain": hunterSupplyChain,
  "implementation-final-review": implementationFinalReview,
  "implementation-fixer": implementationFixer,
  "implementation-triage": implementationTriage,
  "implementation-validator": implementationValidator,
  implementer,
  "pattern-auditor": patternAuditor,
  "quality-score-report": qualityScoreReport,
  "quality-scorer": qualityScorer,
  "review-adversary": reviewAdversary,
  "review-fixer": reviewFixer,
  "review-report": reviewReport,
  "review-scope": reviewScope,
  "review-validator": reviewValidator,
  "run-reporter": runReporter,
  "runtime-safety": runtimeSafety,
  "security-auditor": securityAuditor,
  "security-reviewer": securityReviewer,
  "sync-with-base": syncWithBase,
  "test-engineer": testEngineer,
}
