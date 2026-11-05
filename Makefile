# dsh-agent-dev 发布入口
# 用法：make help

SHELL := /bin/bash
.DEFAULT_GOAL := help

STAGE := pnpm stage publish --access public
MAIN_BRANCH := main

.PHONY: help install build test verify pack check stage-dry publish clean

help: ## 列出所有目标与说明
	@echo "dsh-agent-dev —— 可用目标："
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "发布链路：make check → make stage-dry → make publish → pnpm stage list → pnpm stage approve <stage-id>"

install: ## pnpm install
	pnpm install

build: ## pnpm build（产出 dist-server/）
	pnpm build

test: ## pnpm test（vitest run）
	pnpm test

verify: ## pnpm verify:install（校验包内 skills/）
	pnpm verify:install

pack: ## npm pack --dry-run（查看发布内容清单）
	npm pack --dry-run

check: build test verify pack ## 本地验收：build → test → verify → pack
	@echo "✅ check 全部通过"

stage-dry: ## 演练暂存发布（--dry-run，不上传）
	$(STAGE) --dry-run

publish: ## 暂存到 registry（不立即发布；需随后 approve）
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "❌ 工作区不干净，拒绝发布："; \
		git status --short; \
		exit 1; \
	fi
	@if [ "$$(git rev-parse --abbrev-ref HEAD)" != "$(MAIN_BRANCH)" ] && [ "$(ALLOW_BRANCH)" != "1" ]; then \
		echo "❌ 当前分支不是 $(MAIN_BRANCH)（当前：$$(git rev-parse --abbrev-ref HEAD)），拒绝发布。"; \
		echo "   确需在其他分支发布时：ALLOW_BRANCH=1 make publish"; \
		exit 1; \
	fi
	@$(MAKE) --no-print-directory check
	@echo "ℹ️  pnpm stage 只是把包【暂存】到 registry，不会立即对外发布。"
	@echo "   确认后执行：pnpm stage list，再 pnpm stage approve <stage-id>（含 2FA）完成发布。"
	$(STAGE)

clean: ## pnpm clean（删除 dist/ 与 dist-server/）
	pnpm clean
