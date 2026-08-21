# What changed

<!-- One or two sentences. What is different after this merges? -->

# Why

<!-- The problem, not the solution. If this fixes a defect, say how the
     defect was demonstrated - a failing assertion is worth more than a
     description. -->

# Evidence

- [ ] `npm run verify` is green locally
- [ ] New behaviour is covered by an assertion that fails without the change
- [ ] No test was relaxed to make a suite pass

# Protected paths

<!-- Tick if this touches risk_engine, execution_engine, execution/,
     state/, monitoring/, config/, retry.js or polymarketClient.js. -->

- [ ] This PR changes code that can move money

If ticked, describe what could go wrong and what stops it:

<!-- e.g. "widens the position cap" -> "S6 fuzzes 2000 orders against the
     new limit and still finds no breach" -->

# Not included

<!-- What you deliberately left out, and why. A fix that was tempting but
     out of scope belongs here rather than in the diff. -->
