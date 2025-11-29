# ccbox - Proje Oluşturma Görevi

## Proje Özeti
Güvenli ve izole Claude Code Docker ortamı kuran bir Python CLI aracı.

## Temel Gereksinimler

### 1. Proje Yapısı
```
ccbox/
├── pyproject.toml
├── README.md
├── LICENSE (MIT)
├── src/
│   └── ccbox/
│       ├── __init__.py
│       ├── cli.py
│       ├── config.py
│       ├── generator.py
│       └── templates/
│           ├── Dockerfile.template
│           ├── compose.yml.template
│           └── entrypoint.sh.template
└── tests/
    └── test_cli.py
```

### 2. CLI Komutları (click kullanarak)

| Komut | Açıklama |
|-------|----------|
| `ccbox init` | İnteraktif kurulum wizard'ı |
| `ccbox run` | Mevcut dizinde Claude Code çalıştır |
| `ccbox update` | Docker image'ı güncelle |
| `ccbox clean` | Container ve image temizliği |
| `ccbox config` | Mevcut ayarları göster/değiştir |
| `ccbox doctor` | Sistem gereksinimlerini kontrol et |
| `ccbox status` | Kurulum durumu ve versiyon bilgisi |

### 3. Init Wizard Soruları
```
=== ccbox Setup ===

1. Git Ayarları
   - Kullanıcı adı: [zorunlu]
   - Email: [zorunlu]

2. Performans Ayarları
   - RAM kullanımı (%): [varsayılan: 75]
   - CPU kullanımı (%): [varsayılan: 100]

3. Opsiyonel Araçlar
   - CCO (ClaudeCodeOptimizer) kur? [E/h]
   - GitHub CLI kur? [E/h]
   - Gitleaks kur? [E/h]

4. Kurulum Dizini
   - Windows: %USERPROFILE%\.ccbox
   - Linux/Mac: ~/.ccbox
```

### 4. Dockerfile Template
- Base: node:slim
- Python 3 + pip + venv
- Git, ripgrep, fd-find, jq, curl, wget
- Opsiyonel: CCO, gh, gitleaks
- Dinamik NODE_OPTIONS (RAM'in %X'i, config'den)
- Dinamik UV_THREADPOOL_SIZE (CPU sayısı, config'den)
- claude update kontrolü entrypoint'te
- cco-setup entrypoint'te (eğer CCO kuruluysa)

### 5. Compose Template
- Image adı: ccbox:latest
- Container adı: ccbox-{PROJECT_NAME}
- Dinamik PROJECT_PATH ve PROJECT_NAME
- CLAUDE_CONFIG_DIR environment variable
- Git author/committer bilgileri config'den
- Volume: proje dizini + .claude config dizini
- working_dir dinamik proje adıyla

### 6. Config Dosyası (~/.ccbox/config.json)
```json
{
  "version": "1.0.0",
  "git_name": "...",
  "git_email": "...",
  "ram_percent": 75,
  "cpu_percent": 100,
  "install_cco": true,
  "install_gh": true,
  "install_gitleaks": true,
  "claude_config_dir": "~/.claude"
}
```

### 7. Doctor Komutu Kontrolleri
- [ ] Docker yüklü mü?
- [ ] Docker daemon çalışıyor mu?
- [ ] Yeterli disk alanı var mı? (en az 5GB)
- [ ] Python versiyonu uygun mu? (3.8+)
- [ ] .claude dizini var mı?

### 8. Platform Desteği
- Windows (PowerShell + CMD)
- Linux
- macOS

### 9. Hata Yönetimi
- Docker yoksa anlamlı hata mesajı
- Build hatalarında log göster
- Network hatalarında retry öner

### 10. pyproject.toml
```toml
[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "ccbox"
version = "1.0.0"
description = "Secure Docker environment for Claude Code CLI"
readme = "README.md"
license = {text = "MIT"}
requires-python = ">=3.8"
keywords = ["claude", "docker", "cli", "sandbox", "ai"]
authors = [
    {name = "Sungur Zahid Erdim", email = "sungurerdim@gmail.com"}
]
dependencies = [
    "click>=8.0",
    "rich>=13.0",
]

[project.urls]
Homepage = "https://github.com/sungurerdim/ccbox"
Repository = "https://github.com/sungurerdim/ccbox"

[project.scripts]
ccbox = "ccbox.cli:cli"
```

## Kodlama Standartları
- Type hints kullan
- Docstring ekle
- Error handling: try/except ile
- Logging: rich console kullan
- Cross-platform path handling: pathlib kullan

## Örnek Kullanım Senaryosu
```bash
# 1. Kurulum
pip install ccbox

# 2. İlk yapılandırma
ccbox init
# → Sorulara cevap ver
# → Docker image build edilir

# 3. Herhangi bir proje dizininde
cd ~/projects/my-app
ccbox run
# → Claude Code açılır, izole ortamda çalışır

# 4. Güncelleme gerektiğinde
ccbox update

# 5. Durum kontrolü
ccbox status

# 6. Temizlik
ccbox clean
```

## Başlangıç Adımları

1. [ ] GitHub'da ccbox reposu oluştur
2. [ ] Mevcut çalışan dosyaları kopyala (Dockerfile, compose, bat)
3. [ ] Proje yapısını oluştur (src/ccbox/)
4. [ ] pyproject.toml yaz
5. [ ] Template dosyalarını oluştur (mevcut versiyonlardan)
6. [ ] config.py - yapılandırma yönetimi
7. [ ] generator.py - template'lerden dosya oluşturma
8. [ ] cli.py - tüm komutları implement et
9. [ ] README.md - kurulum ve kullanım dokümantasyonu
10. [ ] Test et: Windows'ta pip install -e . ile
11. [ ] GitHub'a push
12. [ ] PyPI'a yayınla (opsiyonel)

## Mevcut Çalışan Dosyalar (Referans)
- D:\GitHub\claude_setup\Dockerfile
- D:\GitHub\claude_setup\claude-compose.yml
- D:\GitHub\claude_setup\run_claude_code.bat
- D:\GitHub\claude_setup\build_claude_code.bat

Bu dosyalar template'lerin temelini oluşturacak.