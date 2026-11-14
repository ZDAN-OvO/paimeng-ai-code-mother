<template>
  <a-layout-footer class="footer">
    <div class="footer-content">
      <p class="copyright">
        <a
          href="http://github.com/ZDAN-GHN"
          target="_blank"
          rel="noopener noreferrer"
          class="author-link"
        >
          Code by ZDAN-GHN
        </a>
      </p>
    </div>
  </a-layout-footer>
</template>

<script setup lang="ts">
// 无需额外的响应式数据
</script>

<style scoped>
.footer {
  background: transparent;
  text-align: center;
  padding: 24px;
  border-top: 1px solid var(--pm-line);
}

.copyright {
  margin: 0;
  color: var(--pm-ink-3);
  font-size: 13px;
}

.author-link {
  color: var(--pm-ink-2);
  text-decoration: none;
}

.author-link:hover {
  color: var(--pm-brand-strong);
}
</style>
