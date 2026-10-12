pipeline {
    // 윈도우 도커 바인드마운트 워크스페이스는 npm 소파일 I/O가 극악
    //  → 도커 네이티브 볼륨(jenkins_home) 하위 경로에서 빌드 (Job마다 경로 분리)
    agent {
        node {
            label ''
            customWorkspace '/var/jenkins_home/fast_workspace/plugin-webdataVcs'
        }
    }

    // Node 없는 jdk 이미지라 NodeJS 도구 필요:
    //   Manage Jenkins > Tools > NodeJS 에 'node20' 이름으로 설치 등록
    tools { nodejs 'node20' }

    // 자동 빌드 없음 (pollSCM 제거) — 릴리스/복구 시 "Build with Parameters"로 수동 실행
    //   릴리스: package.json 버전업 → master 커밋 → 태그(v<버전>) push → GIT_REF=v<버전> 으로 실행
    //   복구  : NAS에서 유실된 버전을 GIT_REF=v<버전> 으로 재실행 (동결 보호에 걸리면 FORCE)
    parameters {
        string(name: 'GIT_REF', defaultValue: '', description: '배포할 태그 (예: v1.0.1). 비우면 master 빌드만 하고 배포 안 함')
        booleanParam(name: 'FORCE', defaultValue: false, description: 'NAS에 같은 버전이 이미 있어도 덮어쓰기 (복구용)')
    }

    environment {
        PLUGIN_ID = 'webdataVcs' // 설치 경로/파일명 기준 (어댑터 등록명)
        NAS_DIR   = '/upload/plugins'      // Jenkins 컨테이너에 마운트된 NAS 경로
    }

    stages {
        stage('Checkout Tag') {
            when { expression { params.GIT_REF?.trim() } }
            steps {
                script {
                    def remote = scm.userRemoteConfigs[0]
                    checkout([$class: 'GitSCM',
                        branches: [[name: "refs/tags/${params.GIT_REF.trim()}"]],
                        userRemoteConfigs: [[url: remote.url, credentialsId: remote.credentialsId,
                                             refspec: '+refs/tags/*:refs/remotes/origin/tags/*']]])
                }
            }
        }
        stage('Install & Build') {
            steps {
                sh 'npm ci'
                sh 'npm run build'         // webpack → dist/plugin.js
            }
        }
        stage('Deploy to NAS') {
            when { expression { params.GIT_REF?.trim() } }
            steps {
                // 통짜 플러그인: <NAS>/<id>/<version>/plugin.js 로 버전별 누적 배포
                sh '''
                    TAG=$(echo "${GIT_REF}" | tr -d '[:space:]')
                    VER=$(node -p "require('./package.json').version")

                    # 태그와 package.json 버전 불일치 = 버전업 누락 → 중단
                    if [ "${TAG}" != "v${VER}" ]; then
                        echo "태그(${TAG})와 package.json(v${VER}) 버전이 다릅니다"; exit 1
                    fi

                    # 릴리스된 버전은 동결 — 이미 있으면 FORCE 없이는 덮어쓰지 않음
                    DEST="${NAS_DIR}/${PLUGIN_ID}/${VER}"
                    if [ -f "${DEST}/plugin.js" ] && [ "${FORCE}" != "true" ]; then
                        echo "이미 배포된 버전입니다: ${DEST}/plugin.js (덮어쓰려면 FORCE)"; exit 1
                    fi

                    mkdir -p "${DEST}"
                    cp dist/plugin.js "${DEST}/plugin.js"
                    echo "배포 완료: ${DEST}/plugin.js"
                '''
            }
        }
    }
}
