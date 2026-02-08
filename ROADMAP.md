# ccbox v1.0 Roadmap

Bu doküman ccbox'u production-ready hale getirmek için gereken tüm değişiklikleri içerir.

## Vizyon

```
ccbox = Güvenli İzolasyon + Native Claude Code Deneyimi + Cross-platform Session Uyumu
```

**Hedef**: Docker Sandboxes'un microVM-level izolasyonuna eşdeğer güvenlik,
ama ücretsiz ve native Claude Code feature parity ile.

---

## Faz 0: Temizlik ve Basitleştirme

### 0.1 Zero-Residue Mode
- [ ] Container içinde oluşan tüm cache/log/trace dosyalarının temizlenmesi
- [ ] FUSE trace log varsayılan olarak kapalı
- [ ] Session sonunda otomatik cleanup

### 0.2 Kod Basitleştirme
- [ ] Gereksiz dosya ve modüllerin kaldırılması
- [ ] Entrypoint.sh'ın sadeleştirilmesi (450 → <150 satır)
- [ ] Tek sorumluluk prensibine uyum

### 0.3 Error Handling Birleştirme
- [ ] Tüm hata pattern'lerinin standardize edilmesi
- [ ] User-friendly hata mesajları

---

## Faz 1: Güvenlik İyileştirmeleri (Docker Sandboxes'tan Esinlenen)

### 1.1 Network Isolation
- [ ] HTTP/HTTPS proxy desteği (allowlist/denylist)
- [ ] Varsayılan: private IP aralıkları bloklu
- [ ] `ccbox --network=isolated` modu
- [ ] Network policy JSON config

### 1.2 Filesystem Isolation Güçlendirme
- [ ] Read-only root filesystem opsiyonu
- [ ] Sensitive path'lerin otomatik maskelenmesi (~/.ssh, ~/.aws, etc.)
- [ ] Mount whitelist mekanizması

### 1.3 Resource Limits
- [ ] Memory limit (varsayılan + override)
- [ ] CPU quota
- [ ] Disk quota
- [ ] Process limit (mevcut, iyileştirilecek)

---

## Faz 2: Native Feature Parity

### 2.1 Claude Code Native Features Test Matrix
- [ ] /rules - custom rules çalışıyor mu?
- [ ] /plugins - marketplace + custom plugins
- [ ] /mcp - MCP server bağlantıları
- [ ] Custom commands
- [ ] Hooks (pre/post)
- [ ] Settings sync
- [ ] Session resume
- [ ] Worktree support

### 2.2 Path Transform İyileştirmeleri
- [ ] Bidirectional atomic transform
- [ ] Edge case'lerin düzeltilmesi
- [ ] Performance optimizasyonları

### 2.3 Session Integrity
- [ ] Session index regeneration fix
- [ ] Shadow directory merging iyileştirmesi
- [ ] Cross-platform session ID uyumu

---

## Faz 3: UX/DX İyileştirmeleri

### 3.1 Pre-built Images
- [ ] Docker Hub'da official ccbox images
- [ ] `ccbox --pull` ile hızlı başlangıç
- [ ] Stack-specific pre-built images

### 3.2 Configuration File
- [ ] `ccbox.yaml` veya `.ccboxrc` desteği
- [ ] Per-project configuration
- [ ] Global defaults

### 3.3 CLI İyileştirmeleri
- [ ] Daha iyi progress feedback
- [ ] Structured logging
- [ ] Man page ve örnekler

---

## Faz 4: Advanced Features

### 4.1 Snapshot/Restore (Docker Sandboxes benzeri)
- [ ] Container state snapshot
- [ ] Hızlı restore
- [ ] Branch-per-feature workflow

### 4.2 Multi-container Support
- [ ] docker-compose.yml desteği
- [ ] Service bağlantıları
- [ ] Development database containers

### 4.3 Remote Execution
- [ ] SSH üzerinden remote Docker host
- [ ] Cloud container instances

---

## Teknik Borç Ödeme

### Kod Kalitesi
- [ ] Cyclomatic complexity <15 tüm fonksiyonlar
- [ ] Method lines <50
- [ ] File lines <500
- [ ] E2E test coverage

### FUSE Refactoring
- [x] C kodunu Go'ya port et (hanwen/go-fuse v2)
- [x] CGO_ENABLED=0 statik binary, Docker buildx bağımlılığı kaldırıldı
- [x] LRU read cache, skip cache, negative dentry cache
- [x] sync.Pool buffer pooling
- [ ] Error recovery iyileştirmesi

### fakepath.so İyileştirmesi
- [x] Multi-mapping desteği (CCBOX_PATH_MAP)
- [x] Thread safety (pthread_once)
- [x] TLS path cache (32 slot, FNV-1a)
- [x] Macro-based code generation (~65 interceptor)
- [ ] Daha fazla interceptor coverage gerektiğinde ekle

---

## Metrikler ve Başarı Kriterleri

| Metrik | Mevcut | Hedef v1.0 |
|--------|--------|------------|
| İlk çalıştırma süresi | ~2-5 dk (build) | <30 sn (pull) |
| Native feature parity | ~80% | 100% |
| Zero residue | ❌ | ✅ |
| Network isolation | ❌ | ✅ |
| E2E test coverage | 0% | >80% |
| Documentation | README only | Full docs |

---

## Referanslar

- [Docker Sandboxes Architecture](https://docs.docker.com/ai/sandboxes/architecture/)
- [Docker Sandboxes Network Policies](https://docs.docker.com/ai/sandboxes/network-policies/)
- [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)
