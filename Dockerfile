# The harness. Models stay outside — see compose.yaml.
#
# No build step: `node src/daemon.ts` runs TypeScript through Node's own type
# stripping, which is why `tsconfig` sets `erasableSyntaxOnly` and why there is
# nothing to compile here. The image is the source plus its runtime deps.
FROM node:24-slim

# `node:sqlite` is a hard requirement (src/knowledge/db.ts) and was experimental
# for part of Node 22's life. Fail at build time with a clear message rather than
# at the first knowledge write.
RUN node -e "require('node:sqlite'); console.log('node:sqlite ok on', process.version)"

WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree.
COPY package.json package-lock.json* ./
# `--omit=dev` drops vitest and typescript. `npm run typecheck && npm test` stay
# on the host, which the project's own rule already assumes: passing tests are
# not proof the daemon starts, so the daemon is what ships.
RUN npm ci --omit=dev --no-audit --no-fund

# `config/` and `prompts/` are resolved relative to the source file
# (src/config/load.ts, src/prompts/load.ts), so the layout under /app has to
# mirror the repository.
COPY src ./src
COPY prompts ./prompts
COPY config ./config
COPY scripts ./scripts

# Instances are bind-mounted here; see compose.yaml. Named explicitly because
# `homedir()` under a numeric non-root user can resolve to `/`, which is why the
# root is stated rather than inferred (src/instance/discover.ts).
ENV MULTIHARNESS_ROOT=/data

# Not root: sessions, `trace/`, the sqlite store and 0444-sealed step output all
# land on the host through the mount, and root-owned files there would make the
# documented "read the session directory" debugging workflow impossible.
# compose overrides this with the operator's own uid.
USER node

CMD ["node", "src/daemon.ts"]
