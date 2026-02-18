package fuse

// GetSourcePath translates a FUSE path to the actual source path on disk,
// applying directory name mapping (container_name → native_name).
func GetSourcePath(sourceDir, path string, dirMappings []DirMapping) string {
	if len(dirMappings) > 0 && len(path) > 0 && path[0] == '/' {
		translated := translatePathSegments(path, dirMappings)
		return sourceDir + translated
	}
	return sourceDir + path
}

// translatePathSegments replaces container_name segments with native_name.
func translatePathSegments(path string, dirMappings []DirMapping) string {
	if len(dirMappings) == 0 {
		return path
	}

	var b []byte
	i := 0
	for i < len(path) {
		if path[i] == '/' {
			b = append(b, '/')
			i++
			// Check segment after /
			for _, dm := range dirMappings {
				clen := len(dm.ContainerName)
				if i+clen <= len(path) && path[i:i+clen] == dm.ContainerName {
					next := byte(0)
					if i+clen < len(path) {
						next = path[i+clen]
					}
					if next == 0 || next == '/' {
						b = append(b, dm.NativeName...)
						i += clen
						break
					}
				}
			}
		} else {
			b = append(b, path[i])
			i++
		}
	}
	return string(b)
}
