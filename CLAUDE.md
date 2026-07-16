# ops-tools 레포 공통 규칙

게임 운영/CS 지원용 정적 HTML 도구 모음. 각 폴더는 독립 도구이며, 각자의 CLAUDE.md/SPEC.md/LOGIC.md를 우선 참고할 것. 전체 도구 목록은 [README.md](README.md) 참고.

## 이 레포는 상위 `claude-work` 레포의 서브모듈

- 이 폴더(`ops-tools`) 자체가 별도 git 레포(`dltmddn09/ops-tools`, `main` 브랜치)이며, 상위 레포 `claude-work`(`dltmddn09/claude-work`, `master` 브랜치)에 서브모듈로 포함되어 있음.
- **커밋/푸시는 반드시 2단계**:
  1. `ops-tools` 서브모듈 안에서 변경사항 커밋 + `origin main` 푸시
  2. 상위 `claude-work` 레포로 이동해 서브모듈 포인터 변경분만 커밋 + `origin master` 푸시 (다른 무관한 변경사항과 섞어서 커밋하지 말 것)
- 1단계만 하고 2단계를 빠뜨리면, 상위 레포 기준으로는 여전히 예전 커밋을 가리키고 있어 실질적으로 반영되지 않은 것과 같음.
