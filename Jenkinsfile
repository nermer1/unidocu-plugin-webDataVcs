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

    // GitHub 웹훅(인바운드) 불가 → 폴링(아웃바운드)으로 변경 감지
    triggers { pollSCM('H/5 * * * *') }

    environment {
        PLUGIN_ID = 'webdataVcs'          // 설치 경로/파일명 기준 (어댑터 등록명)
        VERSION   = '1.0.0'
        NAS_DIR   = '/upload/plugins'      // Jenkins 컨테이너에 마운트된 NAS 경로
    }

    stages {
        stage('Install & Build') {
            steps {
                sh 'npm ci'
                sh 'npm run build'         // webpack → dist/plugin.js
            }
        }
        stage('Deploy to NAS') {
            steps {
                // 통짜 플러그인: <NAS>/<id>/<version>/plugin.js 로 버전별 누적 배포 (덮어쓰기 X)
                sh '''
                    VER=$(node -p "require('./package.json').version")
                    DEST="${NAS_DIR}/${PLUGIN_ID}/${VER}"
                    mkdir -p "${DEST}"
                    cp dist/plugin.js "${DEST}/plugin.js"
                    echo "배포 완료: ${DEST}/plugin.js"
                '''
            }
        }
    }
}
