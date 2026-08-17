import { Controller, Get, UseGuards } from '@nestjs/common';
import { DemoOnlyGuard } from '../demo/demo-only.guard';
import { PREVIEW_FIXTURES } from './preview-fixtures';

// U-4: exposes F-1's fixture set to the builder (client-side, fetched once when the
// fixture selector loads — never per keystroke/per-edit, so this does not violate
// D-34's "no server round trip for rendering" rule. This endpoint returns static,
// already-computed data; the actual rendering still happens entirely in the browser.
@Controller('v1/fixtures')
@UseGuards(DemoOnlyGuard)
export class FixturesController {
  @Get()
  list() {
    return PREVIEW_FIXTURES;
  }
}
