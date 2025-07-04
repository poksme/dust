use crate::data_sources::data_source::DataSourceESDocument;
use anyhow::Result;
use serde_json::Value;

use crate::data_sources::node::{NodeESDocument, DATA_SOURCE_NODE_INDEX_NAME};

#[derive(Debug, Clone)]
pub enum SearchItem {
    Node(NodeESDocument),
    DataSource(DataSourceESDocument),
}

impl SearchItem {
    pub fn from_hit(hit: &Value) -> Result<Self> {
        let source = hit
            .get("_source")
            .ok_or_else(|| anyhow::anyhow!("Missing _source"))?;

        let index = hit
            .get("_index")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing _index"))?;

        // /!\ Very important, must be kept that way since both indices start with the same prefix.
        if index.starts_with(DATA_SOURCE_NODE_INDEX_NAME) {
            Ok(SearchItem::Node(NodeESDocument::from(source.clone())))
        } else {
            Ok(SearchItem::DataSource(DataSourceESDocument::from(
                source.clone(),
            )))
        }
    }
}
