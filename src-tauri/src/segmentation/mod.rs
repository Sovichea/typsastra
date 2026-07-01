mod provider;
mod registry;

pub use registry::{
    analyze_text, autocomplete_khmer, segmentation_prelude, spelling_suggestions, SegmentationRegistry,
};
