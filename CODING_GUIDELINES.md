# Coding Guidelines

These guidelines ensure consistency and maintainability across the HiddenLayer Artifactory Workers codebase. Please follow them when contributing.

## General Principles

1. **Readability**: Write code that is easy to understand and maintain. Use meaningful variable names and simplify logic before reaching for comments.

2. **Consistency**: Follow existing coding patterns and conventions within the codebase. Consistency makes it easier for developers to understand and contribute to the project.

3. **Simplicity**: Keep your code simple and straightforward. Avoid unnecessary complexity or over-engineering.

4. **Testing**: Write tests for your code whenever possible. Test-driven development (TDD) is encouraged to ensure code quality and reliability.

## TypeScript Guidelines

1. **Strict mode**: All Worker projects use `"strict": true` in their `tsconfig.json`. Do not weaken strictness settings.

2. **Formatting**: Code is formatted with Prettier (see `.prettierrc.js`). Run `npx prettier --check "workers/**/*.ts"` before committing, or configure your editor to format on save.

3. **Linting**: Code is linted with ESLint (see `eslint.config.mjs`). Run `npx eslint workers/` before committing and resolve all errors.

4. **Always use braces**: Every `if`, `else`, `for`, and `while` block must use braces, even for single-line bodies.

5. **Early returns and guard clauses**: Handle edge cases first, keep the happy path at the root indentation level. Do not nest main logic inside success checks.

6. **Imports**: Use `import type` for type-only imports. Use value imports for enums and anything used at runtime. Organize imports with external dependencies first, then local modules.

7. **Error handling**: Handle errors gracefully. Each Worker must never allow an exception to escape the handler. Per-item errors must be isolated so one failure does not abort the run.

8. **No runtime dependencies**: Workers run in JFrog's sandboxed environment with no module resolution. The only permitted imports are type-only imports from `jfrog-workers` (erased at compile time) and value imports from the project-local `types.ts` (bundled by the deploy tooling).

## Version Control Guidelines

1. **Branching Strategy**: Follow a branching strategy such as GitFlow or a similar workflow for managing feature branches, releases, and hotfixes.

2. **Commit Messages**: Write clear and descriptive commit messages that explain the purpose of the changes. Use imperative mood and keep messages concise.

3. **Pull Requests**: Open pull requests for code review before merging changes into the main branch. Provide context and test results where applicable.

## Code Review Process

1. **Code Reviews**: Participate in code reviews to provide feedback and ensure code quality. Reviewers should focus on readability, correctness, performance, and security.

2. **Timely Feedback**: Reviewers should provide timely feedback on pull requests to avoid delays in the development process.

3. **Continuous Improvement**: Learn from code reviews and incorporate feedback to improve coding practices and skills.
