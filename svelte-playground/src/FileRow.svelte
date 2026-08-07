<script>
  // filerow.qubc와 같은 마크업 - filerow.css를 그대로 쓰므로 클래스와 data 속성이 같아야 한다.
  let { name, isEntry, isEditing, isPreviewing, hasError, onselect, onrun } = $props();
</script>

<div class="filerow" data-editing={isEditing} data-error={hasError}>
  {#if isPreviewing}
    <span class="filerow__live" title="미리보기 중">*</span>
  {:else}
    <span class="filerow__live"></span>
  {/if}
  <button class="filerow__name" onclick={onselect}>{name}</button>
  {#if hasError}
    <span class="filerow__error" title="컴파일 에러">!</span>
  {/if}
  {#if isEntry}
    <button class="filerow__preview" title="preview" onclick={onrun}>run</button>
  {/if}
</div>
