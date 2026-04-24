핵심은 “지침 파일을 **정적 파일**에서 **조합형(컴포지션)**으로 바꿨기 때문”입니다.

왜 `groups/global/CLAUDE.md`를 없앴나:
- 예전 구조: `global + group` 파일을 각 그룹에서 참조/복사해서 쓰는 방식
- 문제: 중복, 드리프트(그룹마다 내용 불일치), 업데이트 누락
- 새 구조: 스폰할 때마다 `groups/<group>/CLAUDE.md`를 자동 생성
  - 공통 베이스: `/app/CLAUDE.md`
  - 스킬/모듈 fragment
  - MCP instructions fragment
  - 그룹별 영구 메모리는 `CLAUDE.local.md`로 분리

그래서 `global` 폴더를 지운 이유:
- 공통 지침은 이제 `container/CLAUDE.md`(공유 베이스)로 흡수됐고
- `groups/global/CLAUDE.md`는 레거시라 중복 소스가 됨
- 마이그레이션에서 한 번 정리하도록 설계됨

코드 근거:
- 마이그레이션 호출: [src/index.ts](/Users/benny/Documents/GitHub/nanoclaw/src/index.ts:68)
- 설계 설명/컴포지션: [src/claude-md-compose.ts](/Users/benny/Documents/GitHub/nanoclaw/src/claude-md-compose.ts:1)
- 실제 `groups/global` 삭제 로직: [src/claude-md-compose.ts](/Users/benny/Documents/GitHub/nanoclaw/src/claude-md-compose.ts:177)
- 생성된 `CLAUDE.md`는 “수정 금지, `CLAUDE.local.md` 수정” 헤더 포함: [src/claude-md-compose.ts](/Users/benny/Documents/GitHub/nanoclaw/src/claude-md-compose.ts:35)

즉, 의도는 “삭제”가 목적이 아니라, **지침 소스를 단일화하고 그룹 메모리만 로컬에 남기는 구조 전환**입니다.