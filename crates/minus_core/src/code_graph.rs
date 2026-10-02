use napi_derive::napi;
use std::collections::HashMap;
use std::collections::HashSet;

#[napi(object)]
pub struct RsGraphEdge {
    pub source: String,
    pub target: String,
    pub weight: f64,
}

#[napi(object)]
pub struct RsGraphScore {
    pub id: String,
    pub score: f64,
}

/// Immutable adjacency lists are built once per code-index revision.
#[napi]
pub struct RsCodeGraph {
    ids: Vec<String>,
    indices: HashMap<String, usize>,
    outgoing: Vec<Vec<(usize, f64)>>,
    incoming: Vec<Vec<(usize, f64)>>,
}

#[napi]
impl RsCodeGraph {
    #[napi(constructor)]
    pub fn new(ids: Vec<String>, edges: Vec<RsGraphEdge>) -> Self {
        let indices: HashMap<String, usize> = ids.iter().enumerate().map(|(i, id)| (id.clone(), i)).collect();
        let mut outgoing = vec![Vec::new(); ids.len()];
        let mut incoming = vec![Vec::new(); ids.len()];
        for edge in edges {
            if !edge.weight.is_finite() || edge.weight < 0.0 { continue; }
            if let (Some(&source), Some(&target)) = (indices.get(&edge.source), indices.get(&edge.target)) {
                outgoing[source].push((target, edge.weight));
                incoming[target].push((source, edge.weight));
            }
        }
        Self { ids, indices, outgoing, incoming }
    }

    #[napi]
    pub fn personalized_page_rank(
        &self,
        seeds: Vec<RsGraphScore>,
        mode: String,
        max_iterations: u32,
        damping_factor: f64,
    ) -> Vec<RsGraphScore> {
        if seeds.is_empty() || !damping_factor.is_finite() || !(0.0..=1.0).contains(&damping_factor) {
            return Vec::new();
        }
        let total: f64 = seeds.iter().map(|seed| seed.score).sum();
        if !total.is_finite() { return Vec::new(); }
        let seed_count = seeds.len();
        let mut restart = Vec::new();
        for seed in seeds {
            if let Some(&index) = self.indices.get(&seed.id) {
                let score = if total > 0.0 { seed.score / total } else { 1.0 / seed_count as f64 };
                restart.push((index, score));
            }
        }
        let mut current = restart.clone();
        for _ in 0..max_iterations {
            let mut next = Vec::new();
            let mut positions = HashMap::new();
            for &(index, score) in &current {
                if score <= 0.0 { continue; }
                let mut neighbors = Vec::new();
                if mode == "dependencies" || mode == "auto" {
                    neighbors.extend_from_slice(&self.outgoing[index]);
                }
                if mode == "impact" || mode == "auto" {
                    neighbors.extend_from_slice(&self.incoming[index]);
                }
                if neighbors.is_empty() {
                    accumulate(&mut next, &mut positions, index, score * (1.0 - damping_factor));
                    continue;
                }
                let weight_sum: f64 = neighbors.iter().map(|(_, weight)| weight).sum();
                for (neighbor, weight) in neighbors.iter() {
                    let transition = if weight_sum > 0.0 { weight / weight_sum } else { 1.0 / neighbors.len() as f64 };
                    accumulate(&mut next, &mut positions, *neighbor, score * damping_factor * transition);
                }
            }
            for &(index, score) in &restart {
                accumulate(&mut next, &mut positions, index, (1.0 - damping_factor) * score);
            }
            current = next;
        }
        current.into_iter().map(|(index, score)| RsGraphScore { id: self.ids[index].clone(), score }).collect()
    }

    #[napi]
    pub fn personalized_page_rank_top(
        &self,
        seeds: Vec<RsGraphScore>,
        mode: String,
        max_iterations: u32,
        damping_factor: f64,
        limit: u32,
    ) -> Vec<RsGraphScore> {
        let seed_ids: HashSet<String> = seeds.iter().map(|seed| seed.id.clone()).collect();
        let mut scores = self.personalized_page_rank(seeds, mode, max_iterations, damping_factor);
        scores.retain(|score| !seed_ids.contains(score.id.as_str()));
        scores.sort_by(|a, b| b.score.total_cmp(&a.score));
        scores.truncate(limit as usize);
        scores
    }
}

fn accumulate(values: &mut Vec<(usize, f64)>, positions: &mut HashMap<usize, usize>, index: usize, score: f64) {
    if let Some(&position) = positions.get(&index) {
        values[position].1 += score;
    } else {
        positions.insert(index, values.len());
        values.push((index, score));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_rank_respects_direction_and_isolated_seeds() {
        let graph = RsCodeGraph::new(vec!["a".into(), "b".into(), "c".into()], vec![
            RsGraphEdge { source: "a".into(), target: "b".into(), weight: 1.0 },
        ]);
        let dependency = graph.personalized_page_rank(vec![RsGraphScore { id: "a".into(), score: 1.0 }], "dependencies".into(), 1, 0.85);
        assert!(dependency.iter().any(|item| item.id == "b" && (item.score - 0.85).abs() < 1e-10));
        let impact = graph.personalized_page_rank(vec![RsGraphScore { id: "b".into(), score: 1.0 }], "impact".into(), 1, 0.85);
        assert!(impact.iter().any(|item| item.id == "a" && (item.score - 0.85).abs() < 1e-10));
        let isolated = graph.personalized_page_rank(vec![RsGraphScore { id: "c".into(), score: 1.0 }], "auto".into(), 1, 0.85);
        assert!((isolated[0].score - 0.3).abs() < 1e-10);
    }
}
